import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import type {
  AuditWritePort,
  DomainEventPayload,
  ExchangeRateReader,
  PlayEligibilityPort,
  RgExclusionReader,
  Uuid,
  WalletCommands,
} from '@openora/core/contracts';
import {
  makeConflictError,
  moneyAdd,
  moneyCompare,
  moneyEquals,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import { promoPlayerRank, promoRakebackAccrual, promoRakebackClaim } from '../schema/index.js';
import type {
  RakebackClaimBlocker,
  RakebackClaimOutcome,
  RakebackCurrencyAmount,
  RakebackSummary,
} from '../contract/index.js';
import { priceRakeback, rakebackByCurrency, unclaimedRakeback } from '../shared/rakeback-totals.js';

export const RakebackNothingToClaimError = makeConflictError(
  'RakebackNothingToClaimError',
  'There is no unclaimed rakeback',
  { reason: 'nothing_to_claim' },
);
export const RakebackBelowMinimumError = makeConflictError(
  'RakebackBelowMinimumError',
  'Unclaimed rakeback is below the claim minimum',
  { reason: 'below_minimum' },
);
export const RakebackClaimRestrictedError = makeConflictError(
  'RakebackClaimRestrictedError',
  'Rakeback cannot be claimed while a responsible-gambling block is active',
  { reason: 'restricted' },
);
export const RakebackAccountBlockedError = makeConflictError(
  'RakebackAccountBlockedError',
  'Rakeback cannot be claimed on a suspended or closed account',
  { reason: 'account_blocked' },
);
export const RakebackClaimConflictError = makeConflictError(
  'RakebackClaimConflictError',
  'Unclaimed rakeback changed during the claim - retry',
  { reason: 'claim_conflict' },
);

const BLOCKED_STATUSES = ['suspended', 'closed'] as const;
const PROVIDER_NAME = 'rakeback-claim';
const NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

type RakebackPaid = RakebackCurrencyAmount & {
  /** Null on a replayed claim: the balance already moved and was already announced. */
  transactionId: string | null;
};

export type RakebackClaimed = { userId: Uuid; claimId: Uuid; paid: RakebackPaid[] };

type RakebackClaimDeps = {
  drizzle: DrizzleService;
  wallet: WalletCommands | undefined;
  eligibility: PlayEligibilityPort | undefined;
  exclusions: RgExclusionReader | undefined;
  rates: ExchangeRateReader;
  referenceCurrency: string;
  claimMinimum: string;
  audit: AuditWritePort;
  events: EventBus | undefined;
  logger: { info: (context: object, message: string) => void };
};

/**
 * Pays a player's accrued rakeback out, one `cashback` credit per currency, in a single
 * transaction. The `(userId, idempotencyKey)` claim row makes a retry return the first result;
 * flipping exactly the rows that were read from `accrued` to `claimed` makes two claims with
 * different keys pay each row once - the loser finds fewer rows than it credited and rolls back.
 *
 * Rows are read without a lock and only locked by that flip, after each currency's wallet credit:
 * a rollback locks the balance before the round's rows, so taking them in the other order here
 * would deadlock against it.
 */
export class RakebackClaimService {
  constructor(private readonly deps: RakebackClaimDeps) {}

  async summary(userId: Uuid): Promise<RakebackSummary> {
    const db = this.deps.drizzle.db;
    const totals = await unclaimedRakeback(
      db,
      this.deps.rates,
      this.deps.referenceCurrency,
      userId,
    );
    return {
      ...totals,
      claimMinimum: this.deps.claimMinimum,
      claimBlockedBy: await this.blocker(userId, totals),
      lifetimeClaimed: await rakebackByCurrency(db, 'claimed', userId),
    };
  }

  async claim(userId: Uuid, idempotencyKey: string): Promise<RakebackClaimed> {
    return this.deps.drizzle.db.transaction((tx) =>
      this.settle(tx, userId, idempotencyKey, 'claimed'),
    );
  }

  /**
   * Pays everything a player has accrued once they can no longer claim it themselves - a
   * self-exclusion or a closed account - below the minimum and past every block. Null when
   * nothing was left, so running it twice pays once.
   */
  async autoPay(userId: Uuid): Promise<RakebackClaimed | null> {
    try {
      return await this.deps.drizzle.db.transaction((tx) =>
        this.settle(tx, userId, `auto:${randomUUID()}`, 'auto_paid'),
      );
    } catch (err) {
      if (err instanceof RakebackNothingToClaimError) {
        return null;
      }
      throw err;
    }
  }

  async dueForAutoPayout(): Promise<Uuid[]> {
    const rows = await this.deps.drizzle.db
      .selectDistinct({
        userId: promoRakebackAccrual.userId,
        status: player.status,
        rgBlocked: user.rgBlocked,
      })
      .from(promoRakebackAccrual)
      .leftJoin(player, eq(player.userId, promoRakebackAccrual.userId))
      .leftJoin(user, eq(user.id, promoRakebackAccrual.userId))
      .where(
        and(
          eq(promoRakebackAccrual.status, 'accrued'),
          or(inArray(player.status, ['closed', 'self_excluded']), eq(user.rgBlocked, true)),
        ),
      );
    const due: Uuid[] = [];
    for (const row of rows) {
      if (row.status === 'closed' || row.status === 'self_excluded') {
        due.push(row.userId);
        continue;
      }
      // An RG block is also a cooling-off, which keeps the rakeback for the player to claim later.
      const state = await this.deps.exclusions?.getExclusionState(row.userId);
      if (state?.isSelfExcluded) {
        due.push(row.userId);
      }
    }
    return due;
  }

  /**
   * Tells each player whose unclaimed rakeback has reached the minimum, at most once a day and
   * never one who could not claim it. The timestamp is written before `announce` runs, so a crash
   * between them drops one reminder rather than repeating it.
   */
  async notifyClaimable(
    announce: (claimable: DomainEventPayload<'promo.rakeback.claimable'>) => void,
    now = new Date(),
  ): Promise<number> {
    const db = this.deps.drizzle.db;
    const cutoff = new Date(now.getTime() - NOTIFY_INTERVAL_MS);
    const rows = await db
      .select({
        userId: promoRakebackAccrual.userId,
        currency: promoRakebackAccrual.currency,
        amount: sql<string>`sum(${promoRakebackAccrual.amount})::text`,
      })
      .from(promoRakebackAccrual)
      .innerJoin(promoPlayerRank, eq(promoPlayerRank.userId, promoRakebackAccrual.userId))
      .where(
        and(
          eq(promoRakebackAccrual.status, 'accrued'),
          or(
            isNull(promoPlayerRank.lastClaimableNotifiedAt),
            lt(promoPlayerRank.lastClaimableNotifiedAt, cutoff),
          ),
        ),
      )
      .groupBy(promoRakebackAccrual.userId, promoRakebackAccrual.currency)
      .orderBy(asc(promoRakebackAccrual.userId), asc(promoRakebackAccrual.currency));
    const byUser = new Map<Uuid, RakebackCurrencyAmount[]>();
    for (const { userId, currency, amount } of rows) {
      const amounts = byUser.get(userId) ?? [];
      amounts.push({ currency, amount });
      byUser.set(userId, amounts);
    }
    let notified = 0;
    for (const [userId, amounts] of byUser) {
      const totals = await priceRakeback(db, this.deps.rates, this.deps.referenceCurrency, amounts);
      if (moneyCompare(totals.referenceTotal, this.deps.claimMinimum) < 0) {
        continue;
      }
      if ((await this.blocker(userId, totals)) !== null) {
        continue;
      }
      const [claimed] = await db
        .update(promoPlayerRank)
        .set({ lastClaimableNotifiedAt: now })
        .where(
          and(
            eq(promoPlayerRank.userId, userId),
            or(
              isNull(promoPlayerRank.lastClaimableNotifiedAt),
              lt(promoPlayerRank.lastClaimableNotifiedAt, cutoff),
            ),
          ),
        )
        .returning({ userId: promoPlayerRank.userId });
      if (!claimed) {
        continue;
      }
      announce({ userId, amount: totals.referenceTotal, currency: totals.referenceCurrency });
      notified += 1;
    }
    return notified;
  }

  private async settle(
    tx: DrizzleTx,
    userId: Uuid,
    idempotencyKey: string,
    outcome: RakebackClaimOutcome,
  ): Promise<RakebackClaimed> {
    const wallet = this.deps.wallet;
    if (!wallet) {
      throw new Error('rakeback claim needs WALLET_COMMANDS bound');
    }
    const [claim] = await tx
      .insert(promoRakebackClaim)
      .values({ userId, idempotencyKey, outcome })
      .onConflictDoNothing()
      .returning({ id: promoRakebackClaim.id });
    if (!claim) {
      return this.replay(tx, userId, idempotencyKey);
    }
    if (outcome === 'claimed') {
      await this.assertMayClaim(tx, userId);
    }
    const rows = await tx
      .select({
        id: promoRakebackAccrual.id,
        currency: promoRakebackAccrual.currency,
        amount: promoRakebackAccrual.amount,
      })
      .from(promoRakebackAccrual)
      .where(
        and(eq(promoRakebackAccrual.userId, userId), eq(promoRakebackAccrual.status, 'accrued')),
      )
      .orderBy(asc(promoRakebackAccrual.currency), asc(promoRakebackAccrual.id));
    if (rows.length === 0) {
      throw new RakebackNothingToClaimError();
    }
    const byCurrency = new Map<string, { ids: string[]; amount: string }>();
    for (const row of rows) {
      const entry = byCurrency.get(row.currency) ?? { ids: [], amount: '0' };
      entry.ids.push(row.id);
      entry.amount = moneyAdd(entry.amount, row.amount);
      byCurrency.set(row.currency, entry);
    }
    if (outcome === 'claimed') {
      const totals = await priceRakeback(
        tx,
        this.deps.rates,
        this.deps.referenceCurrency,
        [...byCurrency].map(([currency, { amount }]) => ({ currency, amount })),
      );
      if (moneyCompare(totals.referenceTotal, this.deps.claimMinimum) < 0) {
        throw new RakebackBelowMinimumError();
      }
    }

    const paid: RakebackPaid[] = [];
    for (const [currency, { ids, amount }] of byCurrency) {
      const credited = await wallet.credit(tx, {
        userId,
        amount,
        currency,
        type: 'cashback',
        allowNewWallet: true,
        allowNewCurrency: true,
        providerRef: {
          providerName: PROVIDER_NAME,
          providerRefId: `${claim.id}:${currency}`,
          responseSnapshot: { claimId: claim.id },
        },
      });
      if (!credited.ok || !credited.moved) {
        throw new Error(
          `rakeback claim credit failed: ${credited.ok ? 'already credited' : credited.reason}`,
        );
      }
      const flipped = await tx
        .update(promoRakebackAccrual)
        .set({ status: 'claimed', claimId: claim.id, settledAt: new Date() })
        .where(
          and(
            sql`${promoRakebackAccrual.id} = any(${sql.param(ids)}::uuid[])`,
            eq(promoRakebackAccrual.status, 'accrued'),
          ),
        )
        .returning({ amount: promoRakebackAccrual.amount });
      const flippedTotal = flipped.reduce((sum, row) => moneyAdd(sum, row.amount), '0');
      if (flipped.length !== ids.length || !moneyEquals(flippedTotal, amount)) {
        throw new RakebackClaimConflictError();
      }
      paid.push({ currency, amount, transactionId: credited.transactionId });
    }
    await this.deps.audit.recordInTransaction(tx, {
      actorId: outcome === 'claimed' ? userId : null,
      actorType: outcome === 'claimed' ? 'player' : 'system',
      action: outcome === 'claimed' ? 'promo.rakeback.claimed' : 'promo.rakeback.auto_paid',
      resourceType: 'promo_rakeback_claim',
      resourceId: claim.id,
      after: { userId, paid: paid.map(({ currency, amount }) => ({ currency, amount })) },
    });
    await this.announceCredits(tx, userId, paid);
    this.deps.logger.info({ userId, claimId: claim.id, outcome, paid }, 'rakeback claimed');
    return { userId, claimId: claim.id, paid };
  }

  private async announceCredits(tx: DrizzleTx, userId: Uuid, paid: readonly RakebackPaid[]) {
    const events = this.deps.events;
    if (!events) {
      return;
    }
    const [account] = await tx
      .select({ id: player.id })
      .from(player)
      .where(eq(player.userId, userId));
    for (const { currency, amount, transactionId } of paid) {
      if (!transactionId) {
        continue;
      }
      await events.emitInTransaction(tx, 'wallet.balance.changed', {
        userId,
        playerId: account?.id ?? null,
        amount,
        currency,
        transactionId,
        type: 'cashback',
        direction: 'credit',
      });
    }
  }

  private async replay(tx: DrizzleTx, userId: Uuid, idempotencyKey: string) {
    const [claim] = await tx
      .select({ id: promoRakebackClaim.id })
      .from(promoRakebackClaim)
      .where(
        and(
          eq(promoRakebackClaim.userId, userId),
          eq(promoRakebackClaim.idempotencyKey, idempotencyKey),
        ),
      );
    if (!claim) {
      throw new Error('rakeback claim vanished after its idempotency conflict');
    }
    const paid = await tx
      .select({
        currency: promoRakebackAccrual.currency,
        amount: sql<string>`sum(${promoRakebackAccrual.amount})::text`,
      })
      .from(promoRakebackAccrual)
      .where(eq(promoRakebackAccrual.claimId, claim.id))
      .groupBy(promoRakebackAccrual.currency)
      .orderBy(asc(promoRakebackAccrual.currency));
    return {
      userId,
      claimId: claim.id,
      paid: paid.map((row) => ({ ...row, transactionId: null })),
    };
  }

  private async assertMayClaim(tx: DrizzleTx, userId: Uuid) {
    const eligibility = this.deps.eligibility;
    if (!eligibility) {
      throw new Error('rakeback claim needs PLAY_ELIGIBILITY bound');
    }
    if (await eligibility.isRestricted(userId, tx)) {
      throw new RakebackClaimRestrictedError();
    }
    const [account] = await tx
      .select({ status: player.status })
      .from(player)
      .where(eq(player.userId, userId))
      .for('share');
    if (!account || account.status === 'self_excluded') {
      throw new RakebackClaimRestrictedError();
    }
    if ((BLOCKED_STATUSES as readonly string[]).includes(account.status)) {
      throw new RakebackAccountBlockedError();
    }
  }

  private async blocker(
    userId: Uuid,
    totals: { unclaimed: unknown[]; referenceTotal: string },
  ): Promise<RakebackClaimBlocker | null> {
    const db = this.deps.drizzle.db;
    if (!this.deps.eligibility || (await this.deps.eligibility.isRestricted(userId))) {
      return 'restricted';
    }
    const [account] = await db
      .select({ status: player.status })
      .from(player)
      .where(eq(player.userId, userId));
    if (!account || account.status === 'self_excluded') {
      return 'restricted';
    }
    if ((BLOCKED_STATUSES as readonly string[]).includes(account.status)) {
      return 'account_blocked';
    }
    if (totals.unclaimed.length === 0) {
      return 'nothing_to_claim';
    }
    if (moneyCompare(totals.referenceTotal, this.deps.claimMinimum) < 0) {
      return 'below_minimum';
    }
    return null;
  }
}

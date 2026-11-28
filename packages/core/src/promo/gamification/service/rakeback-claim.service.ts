import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  IdentityReader,
  AuditWritePort,
  DomainEventPayload,
  ExchangeRateReader,
  LedgerPlayEligibilityPort,
  RgExclusionReader,
  Uuid,
  WalletCommands,
} from '@openora/core/contracts';
import {
  makeConflictError,
  mapConcurrent,
  moneyAdd,
  moneyCompare,
  moneyEquals,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import {
  promoPlayerRank,
  promoRakebackAccrual,
  promoRakebackClaim,
  promoRakebackClaimPayout,
} from '../schema/index.js';
import type {
  RakebackClaimBlocker,
  RakebackClaimOutcome,
  RakebackCurrencyAmount,
  RakebackSummary,
} from '../contract/index.js';
import { claimedByCurrency, priceRakeback, unclaimedRakeback } from '../shared/rakeback-totals.js';
import { announceCashCredits } from '../shared/cash-credit-event.js';
import {
  cashClaimBlocker,
  claimBlockerOf,
  autoPayoutCandidates,
  isDueForAutoPayout,
  isDueForAutoPayoutLocked,
} from '../shared/cash-claim-eligibility.js';

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

const PROVIDER_NAME = 'rakeback-claim';
const NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_PAYOUT_CHECK_CONCURRENCY = 10;

type RakebackPaid = RakebackCurrencyAmount & {
  transactionId: string | null;
};

export type RakebackClaimed = { userId: Uuid; claimId: Uuid; paid: RakebackPaid[] };

type RakebackClaimDeps = {
  drizzle: DrizzleService;
  wallet: WalletCommands | undefined;
  eligibility: LedgerPlayEligibilityPort | undefined;
  exclusions: RgExclusionReader | undefined;
  rates: ExchangeRateReader;
  referenceCurrency: string;
  claimMinimum: string;
  audit: AuditWritePort;
  events: EventBus | undefined;
  logger: { info: (context: object, message: string) => void };
  identity: IdentityReader;
};

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
      lifetimeClaimed: await claimedByCurrency(db, userId),
    };
  }

  async claim(userId: Uuid, idempotencyKey: string): Promise<RakebackClaimed> {
    return this.deps.drizzle.db.transaction((tx) =>
      this.settle(tx, userId, idempotencyKey, 'claimed'),
    );
  }

  async autoPay(userId: Uuid): Promise<RakebackClaimed | null> {
    try {
      return await this.deps.drizzle.db.transaction(async (tx) =>
        (await isDueForAutoPayoutLocked(tx, this.deps.eligibility, this.deps.exclusions, userId))
          ? this.settle(tx, userId, `auto:${randomUUID()}`, 'auto_paid')
          : null,
      );
    } catch (err) {
      if (err instanceof RakebackNothingToClaimError) {
        return null;
      }
      throw err;
    }
  }

  async dueForAutoPayout(): Promise<Uuid[]> {
    const owed = await this.deps.drizzle.db
      .selectDistinct({ userId: promoRakebackAccrual.userId })
      .from(promoRakebackAccrual)
      .where(eq(promoRakebackAccrual.status, 'accrued'));
    const rows = await autoPayoutCandidates(
      this.deps.eligibility,
      owed.map((row) => row.userId),
    );
    const due = await mapConcurrent(rows, AUTO_PAYOUT_CHECK_CONCURRENCY, (row) =>
      isDueForAutoPayout(this.deps.exclusions, row.userId, row.status),
    );
    return rows.filter((_, index) => due[index]).map((row) => row.userId);
  }

  async notifyClaimable(
    announce: (claimable: DomainEventPayload<'promo.rakeback.claimable'>) => void,
    now = new Date(),
  ): Promise<number> {
    const db = this.deps.drizzle.db;
    const cutoff = new Date(now.getTime() - NOTIFY_INTERVAL_MS);
    const accrued = await db
      .selectDistinct({ userId: promoRakebackAccrual.userId })
      .from(promoRakebackAccrual)
      .innerJoin(promoPlayerRank, eq(promoPlayerRank.userId, promoRakebackAccrual.userId))
      .where(
        and(
          eq(promoRakebackAccrual.status, 'accrued'),
          or(
            isNull(promoPlayerRank.lastClaimableNotifiedAt),
            lt(promoPlayerRank.lastClaimableNotifiedAt, cutoff),
          ),
          or(
            isNull(promoPlayerRank.rakebackReminderCheckedAt),
            gt(promoRakebackAccrual.createdAt, promoPlayerRank.rakebackReminderCheckedAt),
          ),
        ),
      );
    const states =
      (await this.deps.eligibility?.statesOf(accrued.map((row) => row.userId))) ?? new Map();
    const candidates = accrued
      .map((row) => row.userId)
      .filter((userId) => claimBlockerOf(states.get(userId) ?? null, now) === null);
    if (candidates.length === 0) {
      return 0;
    }
    const rows = await db
      .select({
        userId: promoRakebackAccrual.userId,
        currency: promoRakebackAccrual.currency,
        amount: sql<string>`sum(${promoRakebackAccrual.amount})::text`,
      })
      .from(promoRakebackAccrual)
      .where(
        and(
          eq(promoRakebackAccrual.status, 'accrued'),
          sql`${promoRakebackAccrual.userId} = ANY(${sql.param(candidates)}::uuid[])`,
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
        await db
          .update(promoPlayerRank)
          .set({ rakebackReminderCheckedAt: now })
          .where(eq(promoPlayerRank.userId, userId));
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
      await tx.insert(promoRakebackClaimPayout).values({
        claimId: claim.id,
        userId,
        currency,
        amount,
        transactionId: credited.transactionId,
      });
      paid.push({ currency, amount, transactionId: credited.transactionId });
    }
    await this.deps.audit.recordInTransaction(tx, {
      actorId:
        outcome === 'claimed'
          ? ((await this.deps.identity.getPlayerIdByUserId(userId, tx)) ?? userId)
          : null,
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
    await announceCashCredits(tx, { events, identity: this.deps.identity }, userId, paid);
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
        currency: promoRakebackClaimPayout.currency,
        amount: promoRakebackClaimPayout.amount,
      })
      .from(promoRakebackClaimPayout)
      .where(eq(promoRakebackClaimPayout.claimId, claim.id))
      .orderBy(asc(promoRakebackClaimPayout.currency));
    return {
      userId,
      claimId: claim.id,
      paid: paid.map((row) => ({ ...row, transactionId: null })),
    };
  }

  private async assertMayClaim(tx: DrizzleTx, userId: Uuid) {
    if (!this.deps.eligibility) {
      throw new Error('rakeback claim needs LEDGER_PLAY_ELIGIBILITY bound');
    }
    const blocker = await cashClaimBlocker(tx, this.deps.eligibility, userId, { lock: true });
    if (blocker === 'restricted') {
      throw new RakebackClaimRestrictedError();
    }
    if (blocker === 'account_blocked') {
      throw new RakebackAccountBlockedError();
    }
  }

  private async blocker(
    userId: Uuid,
    totals: { unclaimed: unknown[]; referenceTotal: string },
  ): Promise<RakebackClaimBlocker | null> {
    const blocked = await cashClaimBlocker(this.deps.drizzle.db, this.deps.eligibility, userId, {
      lock: false,
    });
    if (blocked !== null) {
      return blocked;
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

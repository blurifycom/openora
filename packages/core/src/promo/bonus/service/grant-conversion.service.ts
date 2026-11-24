import { and, asc, count, eq, gt, inArray, isNull, not, sql } from 'drizzle-orm';
import {
  WalletCommandAmountError,
  WalletReplayMismatchError,
  type AuditWritePort,
  type ClientMeta,
  type TurnoverEntryStatus,
  type Uuid,
  type WalletCommands,
} from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import {
  makeConflictError,
  moneyCompare,
  moneySubtract,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import type {
  ConvertTransferGrantsInput,
  ConvertTransferGrantsResult,
  ConvertedTransferGrant,
  TransferGrantConversionFailure,
  TransferGrantSource,
} from '../contract/index.js';
import { promoGrant, promoGrantRound, type PromoGrant } from '../schema/index.js';
import { capConversion, completeGrant } from '../shared/complete-grant.js';

export const TransferGrantConversionUnavailableError = makeConflictError(
  'TransferGrantConversionUnavailableError',
  'Transfer grants convert into turnover-locked cash only while the turnover requirement is on',
  { reason: 'turnover_disabled' },
);

export const TransferGrantConversionWalletUnavailableError = makeConflictError(
  'TransferGrantConversionWalletUnavailableError',
  'Transfer grants cannot convert: this process has no wallet commands bound',
  { reason: 'wallet_unavailable' },
);

/** The wallet refused a conversion's cash credit; `reason` is the wallet's own. */
export class TransferGrantCreditRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`grant conversion credit refused: ${reason}`);
    this.name = 'TransferGrantCreditRefusedError';
    this.reason = reason;
  }
}

const failureOf = (err: unknown): TransferGrantConversionFailure =>
  err instanceof TransferGrantCreditRefusedError
    ? 'credit_refused'
    : err instanceof WalletReplayMismatchError
      ? 'replay_mismatch'
      : err instanceof WalletCommandAmountError
        ? 'invalid_amount'
        : 'failed';

/** The ledger reference of a conversion's cash credit: one per grant, so a retry replays it. */
const CONVERSION_PROVIDER = 'promo:grant-conversion';

const ZERO = '0';

type Logger = { error: (obj: object, msg: string) => void };

type WalletPorts = Required<
  Pick<WalletCommands, 'credit' | 'movableFunds' | 'addTurnoverRequirement'>
>;

type Outcome = ConvertedTransferGrant | 'open_round' | null;

// A queued (`pending`) grant converts too: activation re-checks `pending` under the grant lock.
const LIVE_STATUSES = ['pending', 'active'] as const;

const isLiveTransferGrant = (sources: readonly TransferGrantSource[]) =>
  and(
    inArray(promoGrant.status, [...LIVE_STATUSES]),
    sql`${promoGrant.expiresAt} > now()`,
    inArray(promoGrant.source, [...sources]),
  );

const openRound = sql`exists (select 1 from ${promoGrantRound} where ${promoGrantRound.grantId} = ${promoGrant.id} and ${promoGrantRound.settledAt} is null)`;

const remainingWagering = (grant: Pick<PromoGrant, 'wageringRequired' | 'wageringProgress'>) => {
  const left = moneySubtract(grant.wageringRequired, grant.wageringProgress);
  return moneyCompare(left, ZERO) > 0 ? left : ZERO;
};

/**
 * Turns live gift, rain and donation grants into real cash that carries a turnover requirement
 * equal to the wagering each grant still had left (ADR-0065), for an operator moving transfer
 * credits from bonus grants to cash. Each grant converts in a transaction of its own.
 */
export class GrantConversionService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
    private readonly events: EventBus,
    private readonly wallet: () => WalletCommands | undefined,
    private readonly turnoverOn: boolean,
    private readonly logger: Logger,
  ) {}

  async convert(
    { sources, limit, dryRun, after }: ConvertTransferGrantsInput,
    actor: { id: Uuid; meta?: ClientMeta | undefined },
  ): Promise<ConvertTransferGrantsResult> {
    const wallet = this.walletPorts();
    // A grant with an open bet is never a candidate, so a page of them cannot stall the batch.
    const candidates = await this.drizzle.db
      .select({ id: promoGrant.id })
      .from(promoGrant)
      .where(
        and(
          isLiveTransferGrant(sources),
          not(openRound),
          after === undefined ? undefined : gt(promoGrant.id, after),
        ),
      )
      .orderBy(asc(promoGrant.id))
      .limit(limit);

    const converted: ConvertedTransferGrant[] = [];
    const failed: NonNullable<ConvertTransferGrantsResult['failed']> = [];
    for (const { id } of candidates) {
      const outcome = dryRun
        ? await this.preview(id, sources)
        : await this.convertOne(wallet, id, sources, actor).catch((err: unknown) => {
            this.logger.error(
              { grantId: id, err },
              'transfer grant conversion failed; the grant stays live',
            );
            failed.push({ grantId: id, reason: failureOf(err) });
            return null;
          });
      if (outcome !== null && outcome !== 'open_round') {
        converted.push(outcome);
      }
    }

    const [left] = await this.drizzle.db
      .select({ n: count() })
      .from(promoGrant)
      .where(isLiveTransferGrant(sources));
    // Counted after the loop, so a grant whose bet opened mid-run counts here once.
    const [open] = await this.drizzle.db
      .select({ n: count() })
      .from(promoGrant)
      .where(and(isLiveTransferGrant(sources), openRound));
    return {
      converted,
      ...(failed.length > 0 ? { failed } : {}),
      skippedOpenRound: open?.n ?? 0,
      remaining: left?.n ?? 0,
      nextCursor: candidates.length < limit ? null : (candidates.at(-1)?.id ?? null),
    };
  }

  private walletPorts(): WalletPorts {
    if (!this.turnoverOn) {
      throw new TransferGrantConversionUnavailableError();
    }
    const wallet = this.wallet();
    if (!wallet?.addTurnoverRequirement || !wallet.movableFunds) {
      throw new TransferGrantConversionWalletUnavailableError();
    }
    return {
      credit: wallet.credit.bind(wallet),
      movableFunds: wallet.movableFunds.bind(wallet),
      addTurnoverRequirement: wallet.addTurnoverRequirement.bind(wallet),
    };
  }

  private async preview(grantId: PromoGrant['id'], sources: readonly TransferGrantSource[]) {
    const db = this.drizzle.db;
    const [grant] = await db
      .select()
      .from(promoGrant)
      .where(and(eq(promoGrant.id, grantId), isLiveTransferGrant(sources)));
    if (!grant) {
      return null;
    }
    if (await this.hasOpenRound(db, grantId)) {
      return 'open_round';
    }
    const cash = capConversion(
      grant.bonusBalance,
      grant.grantedAmount,
      grant.terms.maxWinMultiplier,
    );
    return {
      grantId,
      userId: grant.userId,
      currency: grant.currency,
      cash,
      requiredInCurrency: moneyCompare(cash, ZERO) > 0 ? remainingWagering(grant) : ZERO,
      entryStatus: null,
    };
  }

  private convertOne(
    wallet: WalletPorts,
    grantId: PromoGrant['id'],
    sources: readonly TransferGrantSource[],
    actor: { id: Uuid; meta?: ClientMeta | undefined },
  ): Promise<Outcome> {
    return this.drizzle.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ userId: promoGrant.userId, currency: promoGrant.currency })
        .from(promoGrant)
        .where(eq(promoGrant.id, grantId));
      if (!owner) {
        return null;
      }
      // Taken first, the wallet row lock serialises this with every path that locks grants or the turnover row.
      await wallet.movableFunds(tx, owner);
      const [grant] = await tx
        .select()
        .from(promoGrant)
        .where(and(eq(promoGrant.id, grantId), isLiveTransferGrant(sources)))
        .for('update');
      if (!grant) {
        return null;
      }
      if (await this.hasOpenRound(tx, grantId)) {
        return 'open_round';
      }
      const completion = await completeGrant(tx, grant, { from: LIVE_STATUSES });
      if (!completion) {
        return null;
      }
      const cash = completion.convertedAmount;
      const paysCash = moneyCompare(cash, ZERO) > 0;
      if (paysCash) {
        await this.creditCash(tx, wallet, grant, cash);
      }
      // No cash, nothing to lock: the requirement would hold the player's own deposits instead.
      const requiredInCurrency = paysCash ? remainingWagering(grant) : ZERO;
      const entry =
        moneyCompare(requiredInCurrency, ZERO) > 0
          ? await wallet.addTurnoverRequirement(tx, {
              userId: grant.userId,
              currency: grant.currency,
              requiredInCurrency,
              source: 'grant_conversion',
              sourceRef: grantId,
            })
          : null;
      await this.audit.recordInTransaction(tx, {
        actorType: 'admin',
        actorId: actor.id,
        action: 'promo.bonus.converted_to_cash',
        resourceType: 'promo_grant',
        resourceId: grantId,
        before: {
          status: grant.status,
          source: grant.source,
          bonusBalance: grant.bonusBalance,
          linkedCash: grant.linkedCash,
          unlinkedCash: grant.unlinkedCash,
          wageringRequired: grant.wageringRequired,
          wageringProgress: grant.wageringProgress,
        },
        after: {
          userId: grant.userId,
          status: 'completed',
          currency: grant.currency,
          cash,
          requiredInCurrency,
          ...(entry === null ? {} : { turnoverEntryId: entry.entryId }),
        },
        ...actor.meta,
      });
      const entryStatus: TurnoverEntryStatus | null = entry?.status ?? null;
      return {
        grantId,
        userId: grant.userId,
        currency: grant.currency,
        cash,
        requiredInCurrency,
        entryStatus,
      };
    });
  }

  private async creditCash(
    tx: DrizzleTx,
    wallet: Pick<WalletCommands, 'credit'>,
    grant: PromoGrant,
    cash: string,
  ): Promise<void> {
    const credited = await wallet.credit(tx, {
      userId: grant.userId,
      amount: cash,
      currency: grant.currency,
      type: 'bonus',
      allowNewCurrency: true,
      providerRef: { providerName: CONVERSION_PROVIDER, providerRefId: grant.id },
    });
    if (!credited.ok) {
      throw new TransferGrantCreditRefusedError(credited.reason);
    }
    if (!credited.moved) {
      return;
    }
    const [account] = await tx
      .select({ id: player.id })
      .from(player)
      .where(eq(player.userId, grant.userId));
    await this.events.emitInTransaction(tx, 'wallet.balance.changed', {
      userId: grant.userId,
      playerId: account?.id ?? null,
      amount: cash,
      currency: grant.currency,
      transactionId: credited.transactionId,
      type: 'bonus',
      direction: 'credit',
    });
  }

  private async hasOpenRound(db: Pick<DrizzleTx, 'select'>, grantId: PromoGrant['id']) {
    const [open] = await db
      .select({ id: promoGrantRound.id })
      .from(promoGrantRound)
      .where(and(eq(promoGrantRound.grantId, grantId), isNull(promoGrantRound.settledAt)))
      .limit(1);
    return open !== undefined;
  }
}

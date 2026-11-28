import { asc, eq, isNull } from 'drizzle-orm';
import type {
  IdentityReader,
  AuditWritePort,
  ExchangeRateReader,
  PlayEligibilityPort,
  Uuid,
  WalletCommands,
} from '@openora/core/contracts';
import type { DrizzleService, DrizzleTx, EventBus } from '@openora/core/server';
import { promoRankChallengeClaim, promoRankChallengeTier } from '../schema/index.js';
import { announceCashCredit } from '../shared/cash-credit-event.js';
import { priceForPayout } from '../shared/payout-currency.js';
import { STUCK_AFTER_FAILURES } from './race-payout.service.js';

export type RankChallengeWon = {
  userId: Uuid;
  tierId: Uuid;
  tierKey: string;
  tierName: string;
  cashAmount: string | null;
  physicalItem: string | null;
  currency: string;
  transactionId: string | null;
};

type Logger = {
  warn: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

export class RankChallengePayoutService {
  private readonly failures = new Map<Uuid, number>();

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly eligibility: PlayEligibilityPort | undefined,
    private readonly wallet: WalletCommands | undefined,
    private readonly rates: ExchangeRateReader,
    private readonly payoutCurrency: string,
    private readonly audit: AuditWritePort,
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly identity: IdentityReader,
  ) {}

  async settlePending(): Promise<RankChallengeWon[]> {
    const pending = await this.drizzle.db
      .select({ id: promoRankChallengeClaim.id })
      .from(promoRankChallengeClaim)
      .where(isNull(promoRankChallengeClaim.settledAt))
      .orderBy(asc(promoRankChallengeClaim.claimedAt));

    const won: RankChallengeWon[] = [];
    for (const { id } of pending) {
      try {
        const result = await this.drizzle.db.transaction((tx) => this.settleOne(tx, id));
        if (result) {
          won.push(result);
        }
        this.failures.delete(id);
      } catch (err) {
        const failures = (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, failures);
        this.logger.error({ err, claimId: id, failures }, 'rank challenge settlement failed');
        if (failures >= STUCK_AFTER_FAILURES) {
          this.logger.error({ claimId: id, failures }, 'rank challenge settlement stuck');
        }
      }
    }
    return won;
  }

  private async settleOne(tx: DrizzleTx, claimId: Uuid): Promise<RankChallengeWon | null> {
    const [claim] = await tx
      .select({
        id: promoRankChallengeClaim.id,
        tierId: promoRankChallengeClaim.tierId,
        userId: promoRankChallengeClaim.userId,
        currency: promoRankChallengeClaim.currency,
        cashAmount: promoRankChallengeClaim.cashAmount,
        physicalItem: promoRankChallengeClaim.physicalItem,
        settledAt: promoRankChallengeClaim.settledAt,
      })
      .from(promoRankChallengeClaim)
      .where(eq(promoRankChallengeClaim.id, claimId))
      .for('update', { skipLocked: true });
    if (!claim || claim.settledAt !== null) {
      return null;
    }
    const [tier] = await tx
      .select({ key: promoRankChallengeTier.key, name: promoRankChallengeTier.name })
      .from(promoRankChallengeTier)
      .where(eq(promoRankChallengeTier.id, claim.tierId));

    const restricted = (await this.eligibility?.isRestricted(claim.userId, tx)) ?? true;
    if (claim.cashAmount !== null && restricted) {
      this.logger.warn(
        { userId: claim.userId, tierId: claim.tierId },
        'rank challenge cash withheld - player restricted',
      );
    }

    let paidCashAmount = claim.cashAmount;
    let paidCurrency = claim.currency;
    let transactionId: string | null = null;
    if (claim.cashAmount !== null && !restricted) {
      if (!this.wallet) {
        throw new Error('WALLET_COMMANDS is not bound');
      }
      const priced = await priceForPayout(
        tx,
        this.rates,
        claim.cashAmount,
        claim.currency,
        this.payoutCurrency,
      );
      const sourceRef = `rank-challenge-payout:${claim.tierId}:${claim.userId}`;
      const credited = await this.wallet.credit(tx, {
        userId: claim.userId,
        amount: priced.amount,
        currency: priced.currency,
        type: 'cashback',
        allowNewCurrency: true,
        allowNewWallet: true,
        providerRef: { providerName: 'promo-rank-challenge', providerRefId: sourceRef },
      });
      if (!credited.ok) {
        throw new Error(`rank challenge cash credit failed: ${credited.reason}`);
      }
      paidCashAmount = priced.amount;
      paidCurrency = priced.currency;
      transactionId = credited.moved ? credited.transactionId : null;
    }

    await tx
      .update(promoRankChallengeClaim)
      .set({
        settledAt: new Date(),
        outcome: restricted ? 'restricted' : 'granted',
        cashGrantId: null,
      })
      .where(eq(promoRankChallengeClaim.id, claimId));

    await this.audit.recordInTransaction(tx, {
      actorType: 'system',
      action: 'promo.rankChallenge.settled',
      resourceType: 'promo_rank_challenge_claim',
      resourceId: claimId,
      before: { settledAt: null },
      after: {
        settledAt: new Date().toISOString(),
        outcome: restricted ? 'restricted' : 'granted',
      },
    });

    if (restricted) {
      return null;
    }
    const won: RankChallengeWon = {
      userId: claim.userId,
      tierId: claim.tierId,
      tierKey: tier?.key ?? '',
      tierName: tier?.name ?? '',
      cashAmount: paidCashAmount,
      physicalItem: claim.physicalItem,
      currency: paidCurrency,
      transactionId,
    };
    await this.events.emitInTransaction(tx, 'promo.rank-challenge.won', won);
    if (paidCashAmount !== null) {
      await announceCashCredit(
        tx,
        { events: this.events, identity: this.identity },
        {
          userId: claim.userId,
          amount: paidCashAmount,
          currency: paidCurrency,
          transactionId,
        },
      );
    }
    return won;
  }
}

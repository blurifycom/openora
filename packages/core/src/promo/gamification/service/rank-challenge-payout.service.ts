import { asc, eq, isNull } from 'drizzle-orm';
import type {
  AuditWritePort,
  ExchangeRateReader,
  PlayEligibilityPort,
  Uuid,
  WalletCommands,
} from '@openora/core/contracts';
import type { DrizzleService, DrizzleTx } from '@openora/core/server';
import { promoRankChallengeClaim, promoRankChallengeTier } from '../schema/index.js';
import { priceForPayout } from '../shared/payout-currency.js';

/** What `plugin.ts` announces per winner, once its own settlement transaction has committed. */
export type RankChallengeWon = {
  userId: Uuid;
  tierId: Uuid;
  tierKey: string;
  tierName: string;
  /** As actually credited, after `priceForPayout` - may differ from the tier's own currency. */
  cashAmount: string | null;
  physicalItem: string | null;
  currency: string;
  /** Null when there was no cash part, or on a replayed credit. */
  transactionId: string | null;
};

type Logger = {
  warn: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

/**
 * Settles a claim `RankChallengeService.recordWager` already inserted: credits the cash portion
 * (if any) once, marks the claim settled, and reports the win for `plugin.ts` to announce -
 * mirroring `RankPayoutService.settleLevelUps`/`StreakPayoutService.settlePending`'s own
 * "read unsettled rows, credit, mark settled, return what to announce" shape, guarded by the
 * same `settledAt is null` idiom `promoRankLevelUp`/`promoStreakMilestoneGrant` use.
 *
 * A player under a responsible-gambling block still gets the claim settled (so a physical prize
 * still reaches the fulfilment queue) - only the cash credit is withheld, the same rule
 * `RacePayoutService` applies to its own grants.
 */
export class RankChallengePayoutService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly eligibility: PlayEligibilityPort | undefined,
    private readonly wallet: WalletCommands | undefined,
    private readonly rates: ExchangeRateReader,
    private readonly payoutCurrency: string,
    private readonly audit: AuditWritePort,
    private readonly logger: Logger,
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
      } catch (err) {
        // One claim's failure must not stop the next tick from settling the others due.
        this.logger.error({ err, claimId: id }, 'rank challenge settlement failed');
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

    const restricted = (await this.eligibility?.isRestricted(claim.userId)) ?? true;
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
      // Never the tier's own currency unconditionally - see RacePayoutService's own use of
      // `priceForPayout` for why. Throws on no rate, rolling back this claim's settlement so the
      // payout job's next tick retries it.
      const priced = await priceForPayout(
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
        providerRef: { providerName: 'promo-rank-challenge', providerRefId: sourceRef },
      });
      if (!credited.ok) {
        // Thrown rather than logged-and-recorded-as-granted: a claim must never settle
        // `outcome: 'granted'` for cash that never moved. See RacePayoutService for the same
        // "roll back and let the job retry" rule.
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

    // Same rule RacePayoutService applies: a restricted player is still ranked/settled, but
    // nothing is announced - the win event exists to tell a player about money or a prize they
    // can act on, and a restricted player's claim is on hold either way.
    if (restricted) {
      return null;
    }
    return {
      userId: claim.userId,
      tierId: claim.tierId,
      tierKey: tier?.key ?? '',
      tierName: tier?.name ?? '',
      cashAmount: paidCashAmount,
      physicalItem: claim.physicalItem,
      currency: paidCurrency,
      transactionId,
    };
  }
}

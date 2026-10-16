import { randomInt } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type {
  BonusGrantCommands,
  DomainEventPayload,
  ExchangeRateReader,
  PlayEligibilityPort,
  Uuid,
  WalletCommands,
  WalletReader,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  moneyScaleBy,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import { promoPlayerRank, promoStreakConfig, promoStreakMilestoneGrant } from '../schema/index.js';
import type { StreakClaimResult, StreakReward } from '../contract/index.js';
import { priceForPayout } from '../shared/payout-currency.js';

type Granted = DomainEventPayload<'promo.bonus.granted'>;

/** What `plugin.ts` announces per cash reward, once the claim's transaction has committed. */
export type StreakCashPaid = {
  userId: Uuid;
  /** As actually credited, after `priceForPayout` - may differ from the streak's own currency. */
  amount: string;
  currency: string;
  /** Null on a replayed credit (the balance already moved and was already announced). */
  transactionId: string | null;
};

export type StreakClaimOutcome = StreakClaimResult & {
  granted: Granted[];
  cashPaid: StreakCashPaid[];
};

export type StreakMilestoneReached = DomainEventPayload<'promo.streak.milestone.reached'>;

export const StreakMilestoneNotClaimableError = makeNotFoundError('StreakMilestone');

const BATCH = 500;
const DAY_MS = 86_400_000;

/** A "gift drop": an amount rolled fresh at settlement, cents precision, uniform over the range. */
function rollGiftDrop(min: string, max: string): string {
  const lowCents = Math.round(Number(min) * 100);
  const highCents = Math.round(Number(max) * 100);
  const cents = highCents > lowCents ? randomInt(lowCents, highCents + 1) : lowCents;
  return (cents / 100).toFixed(2);
}

/**
 * Settles a milestone `StreakService.recordWager` recorded, when its player claims it: every
 * `bonus`/`giftDrop` reward through `BONUS_GRANTS`, every `rakebackBoost` onto the player's own
 * rank row. One milestone can carry several rewards (day 21 pays two gift drops and a fixed
 * bonus); each gets its own `sourceRef` off the milestone row's id, so a retry after a partial
 * failure never pays a reward that already landed twice.
 *
 * A player under a responsible-gambling block gets nothing settled, the same rule
 * `RankPayoutService` applies - a bonus waiting at the end of a block is an incentive to return.
 */
export class StreakPayoutService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly grants: BonusGrantCommands | undefined,
    private readonly eligibility: PlayEligibilityPort | undefined,
    private readonly rates: ExchangeRateReader,
    private readonly walletReader: WalletReader,
    private readonly payoutCurrency: string,
    private readonly wallet?: WalletCommands,
  ) {}

  /**
   * Row lock with SKIP LOCKED plus the unsettled filter make a double or parallel claim settle
   * once; the loser sees the milestone as not claimable.
   */
  async claim(userId: Uuid, milestoneGrantId: Uuid): Promise<StreakClaimOutcome> {
    if (!this.grants || !this.eligibility) {
      throw new Error('streak claim needs BONUS_GRANTS and PLAY_ELIGIBILITY bound');
    }
    return this.drizzle.db.transaction(async (tx) => {
      const [config] = await tx
        .select({ milestones: promoStreakConfig.milestones })
        .from(promoStreakConfig);
      const settled = await this.settleOne(tx, userId, milestoneGrantId, config?.milestones ?? []);
      if (!settled) {
        throw new StreakMilestoneNotClaimableError(milestoneGrantId);
      }
      return settled;
    });
  }

  /**
   * Marks unclaimed milestones nobody has been told about yet as announced and returns them.
   * `recordWager` inserts the milestone inside the bet's own transaction, which has no
   * after-commit hook, so the announcement is read back from committed rows instead. A player
   * under a responsible-gambling block is not invited to claim: the milestone is settled
   * `restricted`, the same outcome a claim would get.
   */
  async announceReached(): Promise<StreakMilestoneReached[]> {
    if (!this.eligibility) {
      return [];
    }
    const eligibility = this.eligibility;
    const [config] = await this.drizzle.db
      .select({ milestones: promoStreakConfig.milestones })
      .from(promoStreakConfig);
    const paidDays = config?.milestones.map((milestone) => milestone.day) ?? [];
    if (paidDays.length === 0) {
      return [];
    }
    const pending = await this.drizzle.db
      .select({ id: promoStreakMilestoneGrant.id })
      .from(promoStreakMilestoneGrant)
      .where(
        and(
          isNull(promoStreakMilestoneGrant.settledAt),
          isNull(promoStreakMilestoneGrant.announcedAt),
          inArray(promoStreakMilestoneGrant.day, paidDays),
        ),
      )
      .limit(BATCH);
    const announced: StreakMilestoneReached[] = [];
    for (const { id } of pending) {
      const reached = await this.drizzle.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ userId: promoStreakMilestoneGrant.userId, day: promoStreakMilestoneGrant.day })
          .from(promoStreakMilestoneGrant)
          .where(
            and(
              eq(promoStreakMilestoneGrant.id, id),
              isNull(promoStreakMilestoneGrant.settledAt),
              isNull(promoStreakMilestoneGrant.announcedAt),
            ),
          )
          .for('update', { skipLocked: true });
        if (!row) {
          return null;
        }
        const restricted = await eligibility.isRestricted(row.userId, tx);
        await tx
          .update(promoStreakMilestoneGrant)
          .set(
            restricted
              ? { settledAt: new Date(), outcome: 'restricted' }
              : { announcedAt: new Date() },
          )
          .where(eq(promoStreakMilestoneGrant.id, id));
        return restricted ? null : { ...row, grantId: null };
      });
      if (reached) {
        announced.push(reached);
      }
    }
    return announced;
  }

  /**
   * Settles every reward a player has not claimed as `restricted` when a responsible-gambling
   * block starts, the same rule that forfeits their active bonuses.
   */
  async forfeitUnclaimed(userId: Uuid): Promise<number> {
    const settled = await this.drizzle.db
      .update(promoStreakMilestoneGrant)
      .set({ settledAt: new Date(), outcome: 'restricted' })
      .where(
        and(
          eq(promoStreakMilestoneGrant.userId, userId),
          isNull(promoStreakMilestoneGrant.settledAt),
        ),
      )
      .returning({ id: promoStreakMilestoneGrant.id });
    return settled.length;
  }

  private async settleOne(
    tx: DrizzleTx,
    userId: Uuid,
    id: Uuid,
    milestones: readonly { day: number; rewards: readonly StreakReward[] }[],
  ): Promise<StreakClaimOutcome | null> {
    const [row] = await tx
      .select({
        day: promoStreakMilestoneGrant.day,
        reachedAt: promoStreakMilestoneGrant.reachedAt,
      })
      .from(promoStreakMilestoneGrant)
      .where(
        and(
          eq(promoStreakMilestoneGrant.id, id),
          eq(promoStreakMilestoneGrant.userId, userId),
          isNull(promoStreakMilestoneGrant.settledAt),
        ),
      )
      .for('update', { skipLocked: true });
    const milestone = row && milestones.find((m) => m.day === row.day);
    if (!milestone) {
      return null;
    }
    const settle = (outcome: StreakClaimResult['outcome']) =>
      tx
        .update(promoStreakMilestoneGrant)
        .set({ settledAt: new Date(), outcome })
        .where(eq(promoStreakMilestoneGrant.id, id));

    if ((await this.eligibility?.isRestricted(userId, tx)) ?? true) {
      await settle('restricted');
      return { outcome: 'restricted', granted: [], cashPaid: [] };
    }
    const granted: Granted[] = [];
    const cashPaid: StreakCashPaid[] = [];
    for (const [index, reward] of milestone.rewards.entries()) {
      // A settled row is reactivated when its day is reached again, so the reach time keeps
      // each reach's credits apart from the last one's.
      const sourceRef = `streak-milestone:${id}:${row.reachedAt.getTime()}:${index}`;
      if (reward.kind === 'rakebackBoost') {
        await this.applyRakebackBoost(tx, userId, reward);
        continue;
      }
      if (reward.kind === 'cash') {
        cashPaid.push(await this.grantCash(tx, userId, reward, sourceRef));
        continue;
      }
      granted.push(await this.grantOne(tx, userId, reward, sourceRef));
    }
    await settle('granted');
    return { outcome: 'granted', granted, cashPaid };
  }

  private async grantOne(
    tx: DrizzleTx,
    userId: Uuid,
    reward: Extract<StreakReward, { kind: 'bonus' | 'giftDrop' }>,
    sourceRef: string,
  ): Promise<Granted> {
    if (!this.grants) {
      throw new Error('BONUS_GRANTS is not bound');
    }
    const owed = reward.kind === 'bonus' ? reward.amount : rollGiftDrop(reward.min, reward.max);
    const from = await this.currencyFor(tx);
    // A bonus can only be wagered by bets in the currency it was granted in. No rate throws,
    // rolling the claim back so it can be retried.
    const currency = (await this.walletReader.getBalances(userId, tx)).activeCurrency;
    const { amount } = await priceForPayout(tx, this.rates, owed, from, currency);
    const maxBet =
      reward.terms.maxBet === null || reward.terms.maxBet === undefined
        ? null
        : (await priceForPayout(tx, this.rates, reward.terms.maxBet, from, currency)).amount;
    const outcome = await this.grants.grant(tx, {
      userId,
      currency,
      amount,
      source: 'streak',
      sourceRef,
      actor: { type: 'system' },
      terms: {
        wageringMultiplier: reward.terms.wageringMultiplier,
        expiryDays: reward.terms.expiryDays,
        ...(maxBet === null ? {} : { maxBet }),
        ...(reward.terms.maxWinMultiplier === null || reward.terms.maxWinMultiplier === undefined
          ? {}
          : { maxWinMultiplier: reward.terms.maxWinMultiplier }),
      },
    });
    if (!outcome.ok) {
      throw new Error(`grant refused: ${outcome.reason}`);
    }
    if (!outcome.created) {
      throw new Error(`streak bonus ${sourceRef} was already granted`);
    }
    return {
      userId,
      grantId: outcome.grantId,
      currency,
      grantedAmount: amount,
      wageringRequired: moneyScaleBy(amount, reward.terms.wageringMultiplier),
      source: 'streak',
      offerId: null,
    };
  }

  /**
   * `cash`: real money, no bonus grant, no wagering requirement - credited through the same
   * `cashback` wallet transaction type rank rakeback uses. `sourceRef` is the milestone's own
   * `providerRefId`, so a retried claim can never pay the same milestone's cash reward twice.
   */
  private async grantCash(
    tx: DrizzleTx,
    userId: Uuid,
    reward: Extract<StreakReward, { kind: 'cash' }>,
    sourceRef: string,
  ): Promise<StreakCashPaid> {
    if (!this.wallet) {
      throw new Error('WALLET_COMMANDS is not bound');
    }
    const currency = await this.currencyFor(tx);
    // Never the streak's own currency unconditionally - see RacePayoutService's own use of
    // `priceForPayout` for why. Throws on no rate, rolling back the claim so it can be retried.
    const priced = await priceForPayout(
      tx,
      this.rates,
      reward.amount,
      currency,
      this.payoutCurrency,
    );
    const outcome = await this.wallet.credit(tx, {
      userId,
      amount: priced.amount,
      currency: priced.currency,
      type: 'cashback',
      allowNewCurrency: true,
      allowNewWallet: true,
      providerRef: { providerName: 'promo-streak', providerRefId: sourceRef },
    });
    if (!outcome.ok) {
      // Thrown rather than logged-and-settled-as-granted: a milestone must never settle
      // `outcome: 'granted'` for cash that never moved. See RacePayoutService for the same
      // "roll back and retry" rule.
      throw new Error(`streak cash reward failed: ${outcome.reason}`);
    }
    if (!outcome.moved) {
      throw new Error(`streak cash reward ${sourceRef} was already credited`);
    }
    return {
      userId,
      amount: priced.amount,
      currency: priced.currency,
      transactionId: outcome.transactionId,
    };
  }

  private async currencyFor(tx: DrizzleTx) {
    const [config] = await tx
      .select({ currency: promoStreakConfig.currency })
      .from(promoStreakConfig);
    return config?.currency ?? 'USD';
  }

  /**
   * Additive on top of whatever `rakebackPercent` the player's tier already carries; there is no
   * rakeback payout engine in core yet to consume it, so this only records the boost for one to
   * read later. See the streak module's README for the deferral.
   */
  private async applyRakebackBoost(
    tx: DrizzleTx,
    userId: Uuid,
    reward: Extract<StreakReward, { kind: 'rakebackBoost' }>,
  ) {
    const expiresAt = new Date(Date.now() + reward.days * DAY_MS);
    await tx
      .update(promoPlayerRank)
      .set({ rakebackBoostPercent: reward.percentPoints, rakebackBoostExpiresAt: expiresAt })
      .where(eq(promoPlayerRank.userId, userId));
  }
}

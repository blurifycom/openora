import { randomInt } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  BonusGrantCommands,
  DomainEventPayload,
  PlayEligibilityPort,
  Uuid,
  WalletCommands,
} from '@openora/core/contracts';
import { moneyScaleBy, type DrizzleService, type DrizzleTx } from '@openora/core/server';
import { promoPlayerRank, promoStreakConfig, promoStreakMilestoneGrant } from '../schema/index.js';
import type { StreakReward } from '../contract/index.js';

type Granted = DomainEventPayload<'promo.bonus.granted'>;

type Logger = {
  warn: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

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
 * Settles the milestones `StreakService.recordWager` recorded: every `bonus`/`giftDrop` reward
 * through `BONUS_GRANTS`, every `rakebackBoost` onto the player's own rank row. One milestone can
 * carry several rewards (day 21 pays two gift drops and a fixed bonus); each gets its own
 * `sourceRef` off the milestone row's id, so a retry after a partial failure never pays a reward
 * that already landed twice.
 *
 * A player under a responsible-gambling block gets nothing settled, the same rule
 * `RankPayoutService` applies - a bonus waiting at the end of a block is an incentive to return.
 */
export class StreakPayoutService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly grants: BonusGrantCommands | undefined,
    private readonly eligibility: PlayEligibilityPort | undefined,
    private readonly logger: Logger,
    private readonly wallet?: WalletCommands,
  ) {}

  async settlePending(): Promise<Granted[]> {
    if (!this.grants || !this.eligibility) {
      this.logger.warn({}, 'streak payout skipped - bonus grants or play eligibility not bound');
      return [];
    }
    const [config] = await this.drizzle.db
      .select({ milestones: promoStreakConfig.milestones })
      .from(promoStreakConfig);
    if (!config) {
      return [];
    }
    const owed = await this.drizzle.db
      .select({ id: promoStreakMilestoneGrant.id })
      .from(promoStreakMilestoneGrant)
      .where(isNull(promoStreakMilestoneGrant.settledAt))
      .orderBy(asc(promoStreakMilestoneGrant.reachedAt))
      .limit(BATCH);

    const granted: Granted[] = [];
    for (const { id } of owed) {
      try {
        const paid = await this.drizzle.db.transaction((tx) =>
          this.settleOne(tx, id, config.milestones),
        );
        granted.push(...paid);
      } catch (err) {
        // ponytail: a milestone that keeps failing is retried every run; add a failure count if
        // one ever sticks, the same deferral `RankPayoutService.settleLevelUps` takes.
        this.logger.error({ err, milestoneGrantId: id }, 'streak milestone payout failed');
      }
    }
    return granted;
  }

  private async settleOne(
    tx: DrizzleTx,
    id: Uuid,
    milestones: readonly { day: number; rewards: readonly StreakReward[] }[],
  ): Promise<Granted[]> {
    const [row] = await tx
      .select({ userId: promoStreakMilestoneGrant.userId, day: promoStreakMilestoneGrant.day })
      .from(promoStreakMilestoneGrant)
      .where(and(eq(promoStreakMilestoneGrant.id, id), isNull(promoStreakMilestoneGrant.settledAt)))
      .for('update', { skipLocked: true });
    if (!row) {
      return [];
    }
    const settle = (outcome: string) =>
      tx
        .update(promoStreakMilestoneGrant)
        .set({ settledAt: new Date(), outcome })
        .where(eq(promoStreakMilestoneGrant.id, id));

    if ((await this.eligibility?.isRestricted(row.userId)) ?? true) {
      await settle('restricted');
      return [];
    }
    const rewards = milestones.find((m) => m.day === row.day)?.rewards ?? [];
    const granted: Granted[] = [];
    for (const [index, reward] of rewards.entries()) {
      const sourceRef = `streak-milestone:${id}:${index}`;
      if (reward.kind === 'rakebackBoost') {
        await this.applyRakebackBoost(tx, row.userId, reward);
        continue;
      }
      if (reward.kind === 'cash') {
        await this.grantCash(tx, row.userId, reward, sourceRef);
        continue;
      }
      const paid = await this.grantOne(tx, row.userId, reward, sourceRef);
      if (paid) {
        granted.push(paid);
      }
    }
    await settle('granted');
    return granted;
  }

  private async grantOne(
    tx: DrizzleTx,
    userId: Uuid,
    reward: Extract<StreakReward, { kind: 'bonus' | 'giftDrop' }>,
    sourceRef: string,
  ): Promise<Granted | null> {
    if (!this.grants) {
      throw new Error('BONUS_GRANTS is not bound');
    }
    const amount = reward.kind === 'bonus' ? reward.amount : rollGiftDrop(reward.min, reward.max);
    const currency = await this.currencyFor();
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
        ...(reward.terms.maxBet === null || reward.terms.maxBet === undefined
          ? {}
          : { maxBet: reward.terms.maxBet }),
        ...(reward.terms.maxWinMultiplier === null || reward.terms.maxWinMultiplier === undefined
          ? {}
          : { maxWinMultiplier: reward.terms.maxWinMultiplier }),
      },
    });
    if (!outcome.ok) {
      throw new Error(`grant refused: ${outcome.reason}`);
    }
    if (!outcome.created) {
      return null;
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
   * `providerRefId`, so a retried settlement (the failed-milestone retry loop in `settlePending`)
   * can never pay the same milestone's cash reward twice.
   */
  private async grantCash(
    tx: DrizzleTx,
    userId: Uuid,
    reward: Extract<StreakReward, { kind: 'cash' }>,
    sourceRef: string,
  ) {
    if (!this.wallet) {
      throw new Error('WALLET_COMMANDS is not bound');
    }
    const currency = await this.currencyFor();
    const outcome = await this.wallet.credit(tx, {
      userId,
      amount: reward.amount,
      currency,
      type: 'cashback',
      allowNewCurrency: true,
      providerRef: { providerName: 'promo-streak', providerRefId: sourceRef },
    });
    if (!outcome.ok) {
      this.logger.error({ userId, sourceRef, reason: outcome.reason }, 'streak cash reward failed');
    }
  }

  private async currencyFor() {
    const [config] = await this.drizzle.db
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

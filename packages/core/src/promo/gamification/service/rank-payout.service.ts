import { and, asc, eq, gt, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type {
  BonusGrantCommands,
  ExchangeRateReader,
  DomainEventPayload,
  PlayEligibilityPort,
  Uuid,
  WalletReader,
} from '@openora/core/contracts';
import { moneyScaleBy, type DrizzleService, type DrizzleTx } from '@openora/core/server';
import {
  promoPlayerRank,
  promoRankConfig,
  promoRankLevelUp,
  promoRankPeriodWager,
  promoRankTier,
  type RankRewardTerms,
  type RankRewards,
} from '../schema/index.js';
import { lastCompletePeriod, type RankPeriod, type RankPeriodKind } from '../shared/rank-period.js';

type Granted = DomainEventPayload<'promo.bonus.granted'>;

/** What a reward is credited in, in the order the operator asked for it. */
type PayoutSettings = { currency: string | null; inPlayerCurrency: boolean };

type Logger = {
  warn: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

const BATCH = 500;

const PERIOD_BONUS = {
  daily: promoRankTier.dailyBonus,
  weekly: promoRankTier.weeklyBonus,
  monthly: promoRankTier.monthlyBonus,
} as const;

/**
 * Pays what a rank earns: the level-up bonuses `RankService.recordWager` recorded, and the
 * daily, weekly and monthly bonuses. Every payout is a grant through BONUS_GRANTS, whose
 * `(user, source, source_ref)` index is the guard that makes a re-run or a second worker pay
 * nothing twice.
 *
 * A player under a responsible-gambling block gets nothing, and the payout is not held for
 * later: a bonus waiting at the end of a block is an incentive to come back and play. If the
 * block cannot be checked at all, nothing is paid.
 *
 * Each method returns the grants it created, for the caller to announce once they are committed.
 */
export class RankPayoutService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly grants: BonusGrantCommands | undefined,
    private readonly eligibility: PlayEligibilityPort | undefined,
    private readonly rates: ExchangeRateReader,
    private readonly wallet: WalletReader,
    private readonly logger: Logger,
  ) {}

  /**
   * Settles the level-up bonuses still owed, oldest first. One batch per run; the next run picks
   * up where this one stopped.
   */
  async settleLevelUps(): Promise<Granted[]> {
    const settings = await this.settingsFor('levelUp');
    if (!settings) {
      return [];
    }
    const { terms, payout } = settings;
    const owed = await this.drizzle.db
      .select({ id: promoRankLevelUp.id })
      .from(promoRankLevelUp)
      .where(isNull(promoRankLevelUp.settledAt))
      .orderBy(asc(promoRankLevelUp.reachedAt))
      .limit(BATCH);

    const granted: Granted[] = [];
    for (const { id } of owed) {
      try {
        const paid = await this.drizzle.db.transaction((tx) =>
          this.settleLevelUp(tx, id, terms, payout),
        );
        if (paid) {
          granted.push(paid);
        }
      } catch (err) {
        // ponytail: a row that keeps failing is retried every run; add a failure count if one ever sticks
        this.logger.error({ err, levelUpId: id }, 'rank level-up payout failed');
      }
    }
    return granted;
  }

  /**
   * Pays the bonus of the given kind for the last period that closed, to every player who earned
   * it. Safe to run as often as the operator likes: a period already settled is skipped, so the
   * job can tick hourly and still pay a monthly bonus exactly once.
   */
  async payPeriodic(kind: RankPeriodKind, now: Date): Promise<Granted[]> {
    const settings = await this.settingsFor(kind);
    if (!settings) {
      return [];
    }
    const { terms, anchors, paidThrough, payout, requiresActivity, minimumWager } = settings;
    const period = lastCompletePeriod(kind, now, anchors);
    const settled = paidThrough[kind];
    if (settled !== undefined && new Date(settled) >= period.end) {
      return [];
    }
    const bonus = PERIOD_BONUS[kind];
    const granted: Granted[] = [];
    let after = '00000000-0000-0000-0000-000000000000';

    for (;;) {
      const due = await this.playersOwed(kind, period, bonus, after, {
        requiresActivity,
        minimumWager,
      });

      for (const player of due) {
        if (player.amount === null || (await this.isBlocked(player.userId))) {
          continue;
        }
        const owed = { ...player, amount: player.amount };
        try {
          const paid = await this.drizzle.db.transaction((tx) =>
            this.grant(tx, owed, period.sourceRef, terms, payout),
          );
          if (paid) {
            granted.push(paid);
          }
        } catch (err) {
          // One player's failure - an amount an admin changed between two runs of the same
          // period, say - must not cost everyone after them their bonus.
          this.logger.error(
            { err, userId: player.userId, sourceRef: period.sourceRef },
            'rank periodic payout failed',
          );
        }
      }

      const last = due.at(-1);
      if (!last || due.length < BATCH) {
        // Written once the whole period is processed: a run that dies halfway is retried, and
        // each player's own grant key keeps the retry from paying anybody twice.
        await this.markPaid(kind, period.end);
        return granted;
      }
      after = last.userId;
    }
  }

  /**
   * Everyone a period owes: the players holding a rank that carries an amount and, when the
   * operator asks for it, who wagered enough inside the period the payout is settling.
   */
  private playersOwed(
    kind: RankPeriodKind,
    period: RankPeriod,
    bonus: (typeof PERIOD_BONUS)[RankPeriodKind],
    after: string,
    activity: { requiresActivity: boolean; minimumWager: string | null },
  ) {
    const ranked = this.drizzle.db
      .select({
        userId: promoPlayerRank.userId,
        amount: bonus,
        currency: promoRankTier.currency,
      })
      .from(promoPlayerRank)
      .innerJoin(promoRankTier, eq(promoRankTier.id, promoPlayerRank.tierId));
    const holdsAnAmount = [gt(promoPlayerRank.userId, after), isNotNull(bonus)];

    if (!activity.requiresActivity) {
      return ranked
        .where(and(...holdsAnAmount))
        .orderBy(asc(promoPlayerRank.userId))
        .limit(BATCH);
    }

    // "Played in the period" is a question about the window that closed, answered by what the
    // player wagered inside it - not by whether they have played since.
    return ranked
      .innerJoin(
        promoRankPeriodWager,
        and(
          eq(promoRankPeriodWager.userId, promoPlayerRank.userId),
          eq(promoRankPeriodWager.kind, kind),
          eq(promoRankPeriodWager.periodKey, period.sourceRef),
        ),
      )
      .where(
        and(
          ...holdsAnAmount,
          ...(activity.minimumWager === null
            ? []
            : [gte(promoRankPeriodWager.wagered, activity.minimumWager)]),
        ),
      )
      .orderBy(asc(promoPlayerRank.userId))
      .limit(BATCH);
  }

  private async settleLevelUp(
    tx: DrizzleTx,
    id: Uuid,
    terms: RankRewardTerms,
    payout: PayoutSettings,
  ) {
    const [row] = await tx
      .select({
        userId: promoRankLevelUp.userId,
        tierId: promoRankLevelUp.tierId,
        currency: promoRankLevelUp.currency,
        amount: promoRankLevelUp.amount,
      })
      .from(promoRankLevelUp)
      .where(and(eq(promoRankLevelUp.id, id), isNull(promoRankLevelUp.settledAt)))
      .for('update', { skipLocked: true });
    if (!row) {
      return null;
    }
    const settle = (outcome: string, grantId: string | null = null) =>
      tx
        .update(promoRankLevelUp)
        .set({ settledAt: new Date(), outcome, grantId })
        .where(eq(promoRankLevelUp.id, id));

    if (await this.isBlocked(row.userId)) {
      await settle('restricted');
      return null;
    }
    const paid = await this.grant(tx, row, `rank-level-up:${row.tierId}`, terms, payout);
    await settle('granted', paid?.grantId ?? null);
    return paid;
  }

  private async grant(
    tx: DrizzleTx,
    owed: { userId: Uuid; currency: string; amount: string },
    sourceRef: string,
    terms: RankRewardTerms,
    payout: PayoutSettings,
  ): Promise<Granted | null> {
    if (!this.grants) {
      throw new Error('BONUS_GRANTS is not bound');
    }
    const paid = await this.inPayoutCurrency(owed, payout);
    const outcome = await this.grants.grant(tx, {
      userId: owed.userId,
      currency: paid.currency,
      amount: paid.amount,
      source: 'rank',
      sourceRef,
      actor: { type: 'system' },
      terms: {
        wageringMultiplier: terms.wageringMultiplier,
        expiryDays: terms.expiryDays,
        // Both are anti-abuse controls the bonus engine enforces inside the bet, against the
        // snapshot this grant is made under - so an operator loosening them later cannot widen
        // a bonus a player already holds.
        ...(terms.maxBet === null || terms.maxBet === undefined ? {} : { maxBet: terms.maxBet }),
        ...(terms.maxWinMultiplier === null || terms.maxWinMultiplier === undefined
          ? {}
          : { maxWinMultiplier: terms.maxWinMultiplier }),
      },
    });
    if (!outcome.ok) {
      throw new Error(`grant refused: ${outcome.reason}`);
    }
    if (!outcome.created) {
      return null;
    }
    return {
      userId: owed.userId,
      grantId: outcome.grantId,
      currency: paid.currency,
      grantedAmount: paid.amount,
      wageringRequired: moneyScaleBy(paid.amount, terms.wageringMultiplier),
      source: 'rank',
      offerId: null,
    };
  }

  /**
   * The reward as it will be credited. What a rank owes is a value, priced in the ladder's
   * currency; the rate that turns it into money is the rate of the moment the money moves.
   *
   * A bonus can only be wagered by bets in the currency it was granted in, so paying in the
   * currency the player actually plays in is what makes the reward usable at all. The operator's
   * fixed payout currency is the fallback, and the ladder's own is the last resort.
   */
  private async inPayoutCurrency(
    owed: { userId: Uuid; currency: string; amount: string },
    payout: PayoutSettings,
  ) {
    const targets = await this.payoutOrder(owed.userId, payout);
    if (targets.length === 0) {
      // Nothing to convert into: the ladder pays in the currency it is priced in.
      return owed;
    }
    for (const target of targets) {
      if (target === owed.currency) {
        return owed;
      }
      const amount = await this.rates.convert(owed.amount, owed.currency, target);
      if (amount !== null) {
        return { userId: owed.userId, currency: target, amount };
      }
      this.logger.warn(
        { userId: owed.userId, from: owed.currency, to: target },
        'rank payout currency skipped - no rate',
      );
    }
    throw new Error(`no rate to pay a rank reward owed in ${owed.currency}`);
  }

  /** The currencies to try, best first. */
  private async payoutOrder(userId: Uuid, payout: PayoutSettings) {
    const player = payout.inPlayerCurrency
      ? // Answers for a player with no wallet too, with the platform's default currency.
        (await this.wallet.getBalances(userId)).activeCurrency
      : null;
    return [player, payout.currency].flatMap((currency) =>
      currency === null || currency === undefined ? [] : [currency],
    );
  }

  private async settingsFor(kind: keyof RankRewards) {
    if (!this.grants || !this.eligibility) {
      this.logger.warn(
        { kind },
        'rank payout skipped - bonus grants or play eligibility not bound',
      );
      return null;
    }
    const [config] = await this.drizzle.db
      .select({
        rewards: promoRankConfig.rewards,
        anchors: promoRankConfig.payoutAnchors,
        paidThrough: promoRankConfig.paidThrough,
        payoutCurrency: promoRankConfig.payoutCurrency,
        payInPlayerCurrency: promoRankConfig.payInPlayerCurrency,
        periodicRequiresActivity: promoRankConfig.periodicRequiresActivity,
        periodicMinimumWager: promoRankConfig.periodicMinimumWager,
      })
      .from(promoRankConfig);
    const terms = config?.rewards[kind];
    if (!config || !terms) {
      this.logger.warn({ kind }, 'rank payout skipped - no terms configured for this reward');
      return null;
    }
    return {
      terms,
      anchors: config.anchors,
      paidThrough: config.paidThrough,
      payout: {
        currency: config.payoutCurrency,
        inPlayerCurrency: config.payInPlayerCurrency,
      },
      requiresActivity: config.periodicRequiresActivity,
      minimumWager: config.periodicMinimumWager,
    };
  }

  /** Moves the kind's watermark forward, so no later run reaches back into a settled period. */
  private async markPaid(kind: RankPeriodKind, end: Date) {
    await this.drizzle.db.update(promoRankConfig).set({
      paidThrough: sql`${promoRankConfig.paidThrough} || ${JSON.stringify({ [kind]: end.toISOString() })}::jsonb`,
    });
  }

  private async isBlocked(userId: Uuid) {
    // termsFor already refused to run without the port, so this never pays an unchecked player.
    return (await this.eligibility?.isRestricted(userId)) ?? true;
  }
}

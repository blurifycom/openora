import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import type {
  ExchangeRateReader,
  Uuid,
  WagerReversalArgs,
  WagerTrackingArgs,
  WagerTrackingCommands,
  WagerTrackingWalletCredit,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  moneyCompare,
  moneySubtract,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import { STREAK_CURRENCY, type PlayerStreak, type StreakLeaderboard } from '../contract/index.js';
import {
  promoPlayerRank,
  promoPlayerStreak,
  promoStreakConfig,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
  promoStreakRoundWager,
} from '../schema/index.js';
import { roundReversal } from '../shared/round-reversal.js';
import {
  DAY_MS,
  activeRakebackMilestone,
  isStreakLive,
  isoDate,
  yesterdayOf,
} from '../shared/streak-day.js';
import { fixedRewardViews, nextMilestoneAfter } from '../shared/streak-view.js';

export const StreakConfigNotSetError = makeNotFoundError('StreakConfig');

// An empty list counts every bet - the same convention `RankService` uses for eligibleProducts.
const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

type Logger = { warn: (context: object, message: string) => void };

/**
 * The daily streak: a player who wagers the operator's minimum in an eligible product on a UTC
 * calendar day extends their streak. What the streak pays is configured in `promoStreakConfig`: a
 * rakeback rate per milestone day, which `RakebackService` reads, and fixed rewards, which this
 * service unlocks as grant rows the player claims later. Bound alongside `RankService` on the same
 * `WAGER_TRACKING` port through `CompositeWagerTracking` - both read the same bet, on the same
 * transaction, for different ledgers.
 *
 * A day is counted once no matter how many qualifying bets land inside it: the daily wager
 * accumulator (`promoStreakDailyWager`) only tells this service when the threshold has been
 * crossed; `promoPlayerStreak.lastQualifyingDay` is the guard that stops a second bet the same
 * day from advancing the counter twice. The count has no upper limit and no automatic reset.
 *
 * A missed day is observed in two places: the close job (`closeDay`) resets a run whose player
 * did not qualify yesterday, and a qualifying bet that finds its last qualifying day older than
 * yesterday starts a new run rather than extending the broken one - the close job may not have
 * run yet when the next day's first bet lands. While the streak is disabled nothing is counted,
 * and the next close resets every run.
 *
 * A provider rollback takes the round's stake back out of the day it counted on
 * (`reverseWager`); if that drops today back under the minimum, today's advance is undone too -
 * unless the reward it unlocked has already been claimed, since nothing here can take a paid
 * reward back. A day that has already ended is final: a late rollback only corrects its total.
 *
 * Own-money only, the same rule `RaceService`/`RankChallengeService` apply: `args.realAmount`
 * already excludes whatever part of a stake a bonus grant covered, so wagering a bonus never
 * advances the streak.
 */
export class StreakService implements WagerTrackingCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly logger: Logger,
  ) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]> {
    if (moneyCompare(args.realAmount, '0') <= 0) {
      return [];
    }
    const [config] = await tx
      .select({
        enabled: promoStreakConfig.enabled,
        dailyMinWager: promoStreakConfig.dailyMinWager,
        eligibleProducts: promoStreakConfig.eligibleProducts,
        fixedRewards: promoStreakConfig.fixedRewards,
      })
      .from(promoStreakConfig);
    if (!config?.enabled || !countsToward(config.eligibleProducts, args.context.product)) {
      return [];
    }
    const amount =
      args.currency === STREAK_CURRENCY
        ? args.realAmount
        : await this.rates.convert(args.realAmount, args.currency, STREAK_CURRENCY, tx);
    if (amount === null) {
      this.logger.warn(
        { userId: args.userId, from: args.currency, to: STREAK_CURRENCY, amount: args.realAmount },
        'streak wager skipped - no exchange rate',
      );
      return [];
    }

    const now = new Date();
    const today = isoDate(now);
    const yesterday = yesterdayOf(now);
    const [day] = await tx
      .insert(promoStreakDailyWager)
      .values({ userId: args.userId, day: today, currency: STREAK_CURRENCY, wagered: amount })
      .onConflictDoUpdate({
        target: [promoStreakDailyWager.userId, promoStreakDailyWager.day],
        set: {
          wagered: sql`${promoStreakDailyWager.wagered} + ${amount}::numeric`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ wagered: promoStreakDailyWager.wagered });
    if (args.round) {
      await tx
        .insert(promoStreakRoundWager)
        .values({
          userId: args.userId,
          providerName: args.round.providerName,
          currency: args.currency,
          externalRoundId: args.round.externalRoundId,
          day: today,
          stake: args.realAmount,
          wagered: amount,
        })
        .onConflictDoUpdate({
          target: [
            promoStreakRoundWager.userId,
            promoStreakRoundWager.providerName,
            promoStreakRoundWager.currency,
            promoStreakRoundWager.externalRoundId,
            promoStreakRoundWager.day,
          ],
          set: {
            stake: sql`${promoStreakRoundWager.stake} + ${args.realAmount}::numeric`,
            wagered: sql`${promoStreakRoundWager.wagered} + ${amount}::numeric`,
          },
        });
    }
    if (!day || moneyCompare(day.wagered, config.dailyMinWager) < 0) {
      return [];
    }

    // One row per player, upserted per bet - `where` skips the update entirely once today has
    // already advanced the counter, so a second qualifying bet the same day is a no-op here. A
    // run whose last qualifying day was not yesterday is already broken, so today starts it over.
    const next = sql`(CASE WHEN ${promoPlayerStreak.lastQualifyingDay} = ${yesterday}::date THEN ${promoPlayerStreak.current} + 1 ELSE 1 END)`;
    const [advanced] = await tx
      .insert(promoPlayerStreak)
      .values({ userId: args.userId, current: 1, best: 1, lastQualifyingDay: today })
      .onConflictDoUpdate({
        target: promoPlayerStreak.userId,
        set: {
          current: next,
          best: sql`GREATEST(${promoPlayerStreak.best}, ${next})`,
          lastQualifyingDay: today,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${promoPlayerStreak.lastQualifyingDay} is distinct from ${today}::date`,
      })
      .returning({ current: promoPlayerStreak.current });
    if (!advanced) {
      return [];
    }

    const reward = config.fixedRewards.find((candidate) => candidate.day === advanced.current);
    if (reward) {
      const captured = {
        reachedAt: now,
        settledAt: null,
        outcome: null,
        announcedAt: null,
        amount: reward.amount,
        rolloverMultiplier: reward.rolloverMultiplier,
        claimExpiryDays: reward.claimExpiryDays,
        expiresAt: new Date(now.getTime() + reward.claimExpiryDays * DAY_MS),
      };
      await tx
        .insert(promoStreakMilestoneGrant)
        .values({ userId: args.userId, day: advanced.current, ...captured })
        .onConflictDoUpdate({
          target: [promoStreakMilestoneGrant.userId, promoStreakMilestoneGrant.day],
          set: captured,
          setWhere: eq(promoStreakMilestoneGrant.outcome, 'reversed'),
        });
    }
    return [];
  }

  async reverseWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    const rounds = await tx
      .select({
        id: promoStreakRoundWager.id,
        day: promoStreakRoundWager.day,
        stake: promoStreakRoundWager.stake,
        wagered: promoStreakRoundWager.wagered,
      })
      .from(promoStreakRoundWager)
      .where(
        and(
          eq(promoStreakRoundWager.userId, args.userId),
          eq(promoStreakRoundWager.providerName, args.round.providerName),
          eq(promoStreakRoundWager.currency, args.currency),
          eq(promoStreakRoundWager.externalRoundId, args.round.externalRoundId),
          gt(promoStreakRoundWager.stake, '0'),
        ),
      )
      .orderBy(desc(promoStreakRoundWager.day))
      .for('update');

    let remaining = args.realAmount;
    for (const round of rounds) {
      if (moneyCompare(remaining, '0') <= 0) {
        return;
      }
      const reversed = roundReversal(round, remaining);
      remaining = moneySubtract(remaining, reversed.stake);
      await tx
        .update(promoStreakRoundWager)
        .set({
          stake: sql`${promoStreakRoundWager.stake} - ${reversed.stake}::numeric`,
          wagered: sql`${promoStreakRoundWager.wagered} - ${reversed.wagered}::numeric`,
        })
        .where(eq(promoStreakRoundWager.id, round.id));
      const [day] = await tx
        .update(promoStreakDailyWager)
        .set({
          wagered: sql`GREATEST(0, ${promoStreakDailyWager.wagered} - ${reversed.wagered}::numeric)`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(promoStreakDailyWager.userId, args.userId),
            eq(promoStreakDailyWager.day, round.day),
          ),
        )
        .returning({ wagered: promoStreakDailyWager.wagered });
      if (day && round.day === isoDate(new Date())) {
        await this.undoTodayIfBelowMinimum(tx, args.userId, day.wagered);
      }
    }
  }

  /**
   * Undoes today's advance once a rollback has taken today back under the minimum. The day number
   * today reached is `current`. `best` is left alone: it is a record, not something any reward
   * reads.
   */
  private async undoTodayIfBelowMinimum(tx: DrizzleTx, userId: Uuid, todayWagered: string) {
    const [config] = await tx
      .select({ dailyMinWager: promoStreakConfig.dailyMinWager })
      .from(promoStreakConfig);
    if (!config || moneyCompare(todayWagered, config.dailyMinWager) >= 0) {
      return;
    }
    const now = new Date();
    const today = isoDate(now);
    const [streak] = await tx
      .select({ current: promoPlayerStreak.current })
      .from(promoPlayerStreak)
      .where(
        and(eq(promoPlayerStreak.userId, userId), eq(promoPlayerStreak.lastQualifyingDay, today)),
      )
      .for('update');
    if (!streak || streak.current < 1) {
      return;
    }
    const reached = streak.current;
    const [milestone] = await tx
      .select({
        id: promoStreakMilestoneGrant.id,
        settledAt: promoStreakMilestoneGrant.settledAt,
        outcome: promoStreakMilestoneGrant.outcome,
        reachedAt: promoStreakMilestoneGrant.reachedAt,
      })
      .from(promoStreakMilestoneGrant)
      .where(
        and(
          eq(promoStreakMilestoneGrant.userId, userId),
          eq(promoStreakMilestoneGrant.day, reached),
        ),
      )
      .for('update');
    // A row reached on an earlier run is not today's to undo: it stays as it was.
    const reachedToday = milestone !== undefined && isoDate(milestone.reachedAt) === today;
    if (reachedToday && milestone.outcome === 'granted') {
      return;
    }
    if (reachedToday && !milestone.settledAt) {
      // Settled rather than deleted: reaching the same day again reactivates only a `reversed`
      // row, and the row still says why it never paid.
      await tx
        .update(promoStreakMilestoneGrant)
        .set({ settledAt: now, outcome: 'reversed' })
        .where(eq(promoStreakMilestoneGrant.id, milestone.id));
    }
    await tx
      .update(promoPlayerStreak)
      .set({
        current: reached - 1,
        lastQualifyingDay: reached > 1 ? yesterdayOf(now) : null,
        updatedAt: sql`now()`,
      })
      .where(eq(promoPlayerStreak.userId, userId));
  }

  async getForPlayer(userId: Uuid): Promise<PlayerStreak> {
    const db = this.drizzle.db;
    const now = new Date();
    const [config] = await db
      .select({
        enabled: promoStreakConfig.enabled,
        dailyMinWager: promoStreakConfig.dailyMinWager,
        rakebackMilestones: promoStreakConfig.rakebackMilestones,
        fixedRewards: promoStreakConfig.fixedRewards,
      })
      .from(promoStreakConfig);
    const [rank] = await db
      .select({ tierId: promoPlayerRank.tierId })
      .from(promoPlayerRank)
      .where(eq(promoPlayerRank.userId, userId));
    const isRanked = (rank?.tierId ?? null) !== null;
    if (!config) {
      return {
        enabled: false,
        current: 0,
        best: 0,
        todayWagered: '0',
        dailyMinWager: '0',
        currency: STREAK_CURRENCY,
        isRanked,
        activeRate: null,
        nextMilestone: null,
        rakebackMilestones: [],
        fixedRewards: [],
      };
    }
    const [streak] = await db
      .select({
        current: promoPlayerStreak.current,
        best: promoPlayerStreak.best,
        lastQualifyingDay: promoPlayerStreak.lastQualifyingDay,
      })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    const [wagered] = await db
      .select({ wagered: promoStreakDailyWager.wagered })
      .from(promoStreakDailyWager)
      .where(
        and(eq(promoStreakDailyWager.userId, userId), eq(promoStreakDailyWager.day, isoDate(now))),
      );
    const grants = await db
      .select({
        id: promoStreakMilestoneGrant.id,
        day: promoStreakMilestoneGrant.day,
        amount: promoStreakMilestoneGrant.amount,
        rolloverMultiplier: promoStreakMilestoneGrant.rolloverMultiplier,
        claimExpiryDays: promoStreakMilestoneGrant.claimExpiryDays,
        reachedAt: promoStreakMilestoneGrant.reachedAt,
        settledAt: promoStreakMilestoneGrant.settledAt,
        outcome: promoStreakMilestoneGrant.outcome,
        expiresAt: promoStreakMilestoneGrant.expiresAt,
      })
      .from(promoStreakMilestoneGrant)
      .where(eq(promoStreakMilestoneGrant.userId, userId));
    const counting = config.enabled && isStreakLive(streak?.lastQualifyingDay ?? null, now);
    const current = counting ? (streak?.current ?? 0) : 0;
    const milestone = counting ? activeRakebackMilestone(config.rakebackMilestones, current) : null;
    return {
      enabled: config.enabled,
      current,
      best: streak?.best ?? 0,
      todayWagered: wagered?.wagered ?? '0',
      dailyMinWager: config.dailyMinWager,
      currency: STREAK_CURRENCY,
      isRanked,
      activeRate: milestone
        ? isRanked
          ? { mode: 'ranked', percent: milestone.rankedUpliftPercent }
          : { mode: 'unranked', percent: milestone.unrankedRatePercent }
        : null,
      nextMilestone: config.enabled
        ? nextMilestoneAfter({
            current,
            rakebackMilestones: config.rakebackMilestones,
            fixedRewards: config.fixedRewards,
            grants,
          })
        : null,
      rakebackMilestones: config.rakebackMilestones,
      fixedRewards: fixedRewardViews(config.fixedRewards, grants, now),
    };
  }

  async leaderboard(userId: Uuid): Promise<StreakLeaderboard> {
    const top = await this.drizzle.db
      .select({
        userId: promoPlayerStreak.userId,
        streak: promoPlayerStreak.current,
        username: user.username,
      })
      .from(promoPlayerStreak)
      .innerJoin(user, eq(user.id, promoPlayerStreak.userId))
      .where(gt(promoPlayerStreak.current, 0))
      .orderBy(desc(promoPlayerStreak.current))
      .limit(5);

    if (top.some((row) => row.userId === userId)) {
      return { top, ownPosition: top.findIndex((row) => row.userId === userId) + 1 };
    }
    const [own] = await this.drizzle.db
      .select({ current: promoPlayerStreak.current })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    if (!own || own.current <= 0) {
      return { top, ownPosition: null };
    }
    const [{ ahead }] = await this.drizzle.db
      .select({ ahead: sql<number>`count(*)::int` })
      .from(promoPlayerStreak)
      .where(gt(promoPlayerStreak.current, own.current));
    return { top, ownPosition: ahead + 1 };
  }

  /**
   * Daily UTC close: a player whose last qualifying day was not yesterday (and who is not
   * already at zero) missed a day, so their run resets - `best` is untouched, it is the record,
   * not the current attempt. With the streak disabled, or never configured, every run resets: a
   * disabled streak ends them all. Run once per UTC day, after it turns over; safe to run again,
   * since a player already at zero or already qualified for the new day is left alone.
   */
  async closeDay(now: Date): Promise<number> {
    const yesterday = yesterdayOf(now);
    // A rollback can no longer change a day before yesterday, so what its rounds counted is done.
    await this.drizzle.db
      .delete(promoStreakRoundWager)
      .where(lt(promoStreakRoundWager.day, yesterday));
    const [config] = await this.drizzle.db
      .select({ enabled: promoStreakConfig.enabled })
      .from(promoStreakConfig);
    const result = await this.drizzle.db
      .update(promoPlayerStreak)
      .set({ current: 0, updatedAt: sql`now()` })
      .where(
        and(
          gt(promoPlayerStreak.current, 0),
          config?.enabled
            ? sql`(${promoPlayerStreak.lastQualifyingDay} is null or ${promoPlayerStreak.lastQualifyingDay} < ${yesterday}::date)`
            : undefined,
        ),
      );
    return result.rowCount ?? 0;
  }
}

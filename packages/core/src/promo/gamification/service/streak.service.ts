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
import type { PlayerStreak, StreakLeaderboard } from '../contract/index.js';
import {
  promoPlayerStreak,
  promoStreakConfig,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
  promoStreakRoundWager,
} from '../schema/index.js';
import { roundReversal } from '../shared/round-reversal.js';

export const StreakConfigNotSetError = makeNotFoundError('StreakConfig');

// An empty list counts every bet - the same convention `RankService` uses for eligibleProducts.
const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

type Logger = { warn: (context: object, message: string) => void };

/**
 * The daily streak: a player who wagers the operator's minimum in an eligible product on a UTC
 * calendar day keeps their streak, and the milestone list in `promoStreakConfig` is what pays
 * for it. Bound alongside `RankService` on the same `WAGER_TRACKING` port through
 * `CompositeWagerTracking` - both read the same bet, on the same transaction, for different
 * ledgers.
 *
 * A day is counted once no matter how many qualifying bets land inside it: the daily wager
 * accumulator (`promoStreakDailyWager`) only tells this service when the threshold has been
 * crossed; `promoPlayerStreak.lastQualifyingDay` is the guard that stops a second bet the same
 * day from advancing the counter twice.
 *
 * A missed day is observed in two places: the close job (`closeDay`) resets a run whose player
 * did not qualify yesterday, and a qualifying bet that finds its last qualifying day older than
 * yesterday starts a new run rather than extending the broken one - the close job may not have
 * run yet when the next day's first bet lands.
 *
 * A provider rollback takes the round's stake back out of the day it counted on
 * (`reverseWager`); if that drops today back under the minimum, today's advance is undone too -
 * unless the milestone it reached has already paid out, since nothing here can take a paid
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
        currency: promoStreakConfig.currency,
        dailyMinWager: promoStreakConfig.dailyMinWager,
        eligibleProducts: promoStreakConfig.eligibleProducts,
        milestones: promoStreakConfig.milestones,
        resetAfterDay: promoStreakConfig.resetAfterDay,
      })
      .from(promoStreakConfig);
    if (!config || !countsToward(config.eligibleProducts, args.context.product)) {
      return [];
    }
    const amount =
      args.currency === config.currency
        ? args.realAmount
        : await this.rates.convert(args.realAmount, args.currency, config.currency, tx);
    if (amount === null) {
      // ponytail: a wager with no rate does not count toward the streak; revisit if this shows
      // up in logs the way the equivalent rank-side skip would.
      this.logger.warn(
        { userId: args.userId, from: args.currency, to: config.currency, amount: args.realAmount },
        'streak wager skipped - no exchange rate',
      );
      return [];
    }

    const now = new Date();
    const today = isoDate(now);
    const yesterday = isoDate(new Date(now.getTime() - DAY_MS));
    const [day] = await tx
      .insert(promoStreakDailyWager)
      .values({ userId: args.userId, day: today, currency: config.currency, wagered: amount })
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
        where: sql`${promoPlayerStreak.lastQualifyingDay} is distinct from ${today}::date`,
      })
      .returning({ current: promoPlayerStreak.current });
    if (!advanced) {
      return [];
    }

    if (config.milestones.some((milestone) => milestone.day === advanced.current)) {
      // `onConflictDoUpdate` rather than `onConflictDoNothing`: a milestone day reached on an
      // earlier streak, already settled, is reactivated rather than refused - the unique index
      // is per player and day, not per streak attempt.
      await tx
        .insert(promoStreakMilestoneGrant)
        .values({ userId: args.userId, day: advanced.current })
        .onConflictDoUpdate({
          target: [promoStreakMilestoneGrant.userId, promoStreakMilestoneGrant.day],
          set: { reachedAt: sql`now()`, settledAt: null, outcome: null },
          where: sql`${promoStreakMilestoneGrant.settledAt} is not null`,
        });
    }

    if (advanced.current >= config.resetAfterDay) {
      await tx
        .update(promoPlayerStreak)
        .set({ current: 0, updatedAt: sql`now()` })
        .where(eq(promoPlayerStreak.userId, args.userId));
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
   * today reached is `current`, or `resetAfterDay` when that advance completed the run and reset
   * it to zero. `best` is left alone: it is a record, not something any reward reads.
   */
  private async undoTodayIfBelowMinimum(tx: DrizzleTx, userId: Uuid, todayWagered: string) {
    const [config] = await tx
      .select({
        dailyMinWager: promoStreakConfig.dailyMinWager,
        resetAfterDay: promoStreakConfig.resetAfterDay,
      })
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
    if (!streak) {
      return;
    }
    const reached = streak.current === 0 ? config.resetAfterDay : streak.current;
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
    if (milestone?.outcome === 'granted' && isoDate(milestone.reachedAt) === today) {
      return;
    }
    if (milestone && !milestone.settledAt) {
      // Settled rather than deleted, so reaching the same day again reactivates it the way a
      // re-reached milestone always is, and the row still says why it never paid.
      await tx
        .update(promoStreakMilestoneGrant)
        .set({ settledAt: now, outcome: 'reversed' })
        .where(eq(promoStreakMilestoneGrant.id, milestone.id));
    }
    await tx
      .update(promoPlayerStreak)
      .set({
        current: reached - 1,
        lastQualifyingDay: reached > 1 ? isoDate(new Date(now.getTime() - DAY_MS)) : null,
        updatedAt: sql`now()`,
      })
      .where(eq(promoPlayerStreak.userId, userId));
  }

  async getForPlayer(userId: Uuid): Promise<PlayerStreak> {
    const [config] = await this.drizzle.db
      .select({
        currency: promoStreakConfig.currency,
        dailyMinWager: promoStreakConfig.dailyMinWager,
        milestones: promoStreakConfig.milestones,
      })
      .from(promoStreakConfig);
    if (!config) {
      throw new StreakConfigNotSetError('global');
    }
    const today = isoDate(new Date());
    const [streak] = await this.drizzle.db
      .select({ current: promoPlayerStreak.current, best: promoPlayerStreak.best })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, userId));
    const [wagered] = await this.drizzle.db
      .select({ wagered: promoStreakDailyWager.wagered })
      .from(promoStreakDailyWager)
      .where(and(eq(promoStreakDailyWager.userId, userId), eq(promoStreakDailyWager.day, today)));
    return {
      current: streak?.current ?? 0,
      best: streak?.best ?? 0,
      todayWagered: wagered?.wagered ?? '0',
      dailyMinWager: config.dailyMinWager,
      currency: config.currency,
      milestones: config.milestones,
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
   * not the current attempt. Run once per UTC day, after it turns over; safe to run again, since
   * a player already at zero or already qualified for the new day is left alone.
   */
  async closeDay(now: Date): Promise<number> {
    const yesterday = isoDate(new Date(now.getTime() - DAY_MS));
    // A rollback can no longer change a day before yesterday, so what its rounds counted is done.
    await this.drizzle.db
      .delete(promoStreakRoundWager)
      .where(lt(promoStreakRoundWager.day, yesterday));
    const result = await this.drizzle.db
      .update(promoPlayerStreak)
      .set({ current: 0, updatedAt: sql`now()` })
      .where(
        and(
          gt(promoPlayerStreak.current, 0),
          sql`(${promoPlayerStreak.lastQualifyingDay} is null or ${promoPlayerStreak.lastQualifyingDay} < ${yesterday}::date)`,
        ),
      );
    return result.rowCount ?? 0;
  }
}

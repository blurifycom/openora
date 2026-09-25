import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import type {
  ExchangeRateReader,
  Uuid,
  WagerTrackingArgs,
  WagerTrackingCommands,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  moneyCompare,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type { PlayerStreak, StreakLeaderboard } from '../contract/index.js';
import {
  promoPlayerStreak,
  promoStreakConfig,
  promoStreakDailyWager,
  promoStreakMilestoneGrant,
} from '../schema/index.js';

export const StreakConfigNotSetError = makeNotFoundError('StreakConfig');

// An empty list counts every bet - the same convention `RankService` uses for eligibleProducts.
const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

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
 * A missed day is never observed here - only the close job (`closeDay`) sees the absence of a
 * qualifying bet, because nothing else can.
 */
export class StreakService implements WagerTrackingCommands {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader,
    private readonly logger: Logger,
  ) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs) {
    if (moneyCompare(args.amount, '0') <= 0) {
      return;
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
      return;
    }
    const amount =
      args.currency === config.currency
        ? args.amount
        : await this.rates.convert(args.amount, args.currency, config.currency);
    if (amount === null) {
      // ponytail: a wager with no rate does not count toward the streak; revisit if this shows
      // up in logs the way the equivalent rank-side skip would.
      this.logger.warn(
        { userId: args.userId, from: args.currency, to: config.currency, amount: args.amount },
        'streak wager skipped - no exchange rate',
      );
      return;
    }

    const today = isoDate(new Date());
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
    if (!day || moneyCompare(day.wagered, config.dailyMinWager) < 0) {
      return;
    }

    // One row per player, upserted per bet - `where` skips the update entirely once today has
    // already advanced the counter, so a second qualifying bet the same day is a no-op here.
    const [advanced] = await tx
      .insert(promoPlayerStreak)
      .values({ userId: args.userId, current: 1, best: 1, lastQualifyingDay: today })
      .onConflictDoUpdate({
        target: promoPlayerStreak.userId,
        set: {
          current: sql`${promoPlayerStreak.current} + 1`,
          best: sql`GREATEST(${promoPlayerStreak.best}, ${promoPlayerStreak.current} + 1)`,
          lastQualifyingDay: today,
          updatedAt: sql`now()`,
        },
        where: sql`${promoPlayerStreak.lastQualifyingDay} is distinct from ${today}::date`,
      })
      .returning({ current: promoPlayerStreak.current });
    if (!advanced) {
      return;
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
    const yesterday = isoDate(new Date(now.getTime() - 86_400_000));
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

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CONTRIBUTION_PERCENT_PRECISION,
  CONTRIBUTION_PERCENT_SCALE,
  MONEY_PRECISION,
  MONEY_SCALE,
} from '@openora/core/contracts';
import type {
  RankConfig,
  RankPayoutAnchors,
  RankPayoutKind,
  StreakMilestone,
} from '../contract/index.js';

const money = () => decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE });

export const promoRankTier = pgTable(
  'promo_rank_tier',
  {
    id: uuid().primaryKey().defaultRandom(),
    key: text().notNull().unique(),
    name: text().notNull(),
    position: integer().notNull(),
    currency: text().notNull(),
    wagerThreshold: money().notNull(),
    rakebackPercent: decimal({
      precision: CONTRIBUTION_PERCENT_PRECISION,
      scale: CONTRIBUTION_PERCENT_SCALE,
    }).notNull(),
    dailyBonus: money(),
    weeklyBonus: money(),
    monthlyBonus: money(),
    levelUpBonus: money(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      'promo_rank_tier_bounds',
      sql`${t.position} >= 0 AND ${t.wagerThreshold} >= 0
        AND ${t.rakebackPercent} >= 0 AND ${t.rakebackPercent} <= 100
        AND (${t.dailyBonus} is null OR ${t.dailyBonus} > 0)
        AND (${t.weeklyBonus} is null OR ${t.weeklyBonus} > 0)
        AND (${t.monthlyBonus} is null OR ${t.monthlyBonus} > 0)
        AND (${t.levelUpBonus} is null OR ${t.levelUpBonus} > 0)`,
    ),
  ],
);

export type PromoRankTier = typeof promoRankTier.$inferSelect;

export const promoPlayerRank = pgTable(
  'promo_player_rank',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().unique(),
    currency: text().notNull(),
    lifetimeWagered: money().notNull().default('0'),
    tierId: uuid().references(() => promoRankTier.id),
    /** Last counted wager. A periodic bonus goes only to a player active in the period it pays. */
    lastWageredAt: timestamp({ withTimezone: true }),
    /**
     * A streak milestone's temporary lift on top of the tier's own `rakebackPercent`. Additive,
     * and gone once `rakebackBoostExpiresAt` passes - read together, never `rakebackPercent`
     * alone, by anything that pays rakeback.
     */
    rakebackBoostPercent: decimal({
      precision: CONTRIBUTION_PERCENT_PRECISION,
      scale: CONTRIBUTION_PERCENT_SCALE,
    }),
    rakebackBoostExpiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check('promo_player_rank_lifetime_wagered_non_negative', sql`${t.lifetimeWagered} >= 0`)],
);

export type PromoPlayerRank = typeof promoPlayerRank.$inferSelect;

export type RankRewards = RankConfig['rewards'];
export type RankRewardTerms = NonNullable<RankRewards[keyof RankRewards]>;

/**
 * Ladder-wide settings, one row. Absent means the ladder pays nothing and counts nothing: an
 * operator who has not decided what counts toward a rank has not launched ranks.
 */
export const promoRankConfig = pgTable('promo_rank_config', {
  id: uuid().primaryKey().defaultRandom(),
  // Unique, so the table can only ever hold the one row.
  singletonKey: text().notNull().unique().default('global'),
  /** Products whose stakes count toward a rank. Empty counts every product. */
  eligibleProducts: text().array().notNull().default([]),
  /** Terms each reward kind is granted under. A kind with no terms is not paid. */
  rewards: jsonb().$type<RankRewards>().notNull().default({}),
  /** What rewards are credited in, when that is not the ladder's own currency. */
  payoutCurrency: text(),
  /** Credit a reward in the currency the player plays in, falling back to the two above. */
  payInPlayerCurrency: boolean().notNull().default(false),
  /** Pay a periodic bonus only to players who wagered in the period it covers. */
  periodicRequiresActivity: boolean().notNull().default(true),
  /** How much a player must wager inside the period to qualify. Null means any bet counts. */
  periodicMinimumWager: money(),
  /** When each periodic payout closes, and so what window it pays for. All UTC. */
  payoutAnchors: jsonb()
    .$type<RankPayoutAnchors>()
    .notNull()
    .default({ dailyHour: 0, weeklyDay: 1, monthlyDay: 1 }),
  /**
   * The end of the last period each kind was paid for. A payout runs only for a period that
   * ends after its watermark, so moving an anchor cannot pay the same stretch of time twice and
   * a late or repeated tick cannot reach back into a period already settled.
   */
  paidThrough: jsonb().$type<Partial<Record<RankPayoutKind, string>>>().notNull().default({}),
  updatedBy: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PromoRankConfig = typeof promoRankConfig.$inferSelect;

/**
 * How much a player wagered inside one payout period, in the ladder's currency. One row per
 * player per period per kind - written in the bet's own transaction, read by the payout that
 * settles that period.
 *
 * A period of its own rather than a single "last wagered" stamp, because "played in the period"
 * is a question about a window that has closed, and a bet placed a minute after it closed must
 * not answer for it. It is also what an operator's minimum-wager threshold is measured against.
 */
export const promoRankPeriodWager = pgTable(
  'promo_rank_period_wager',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    kind: text().$type<RankPayoutKind>().notNull(),
    /** The period's own key, the same one the payout is granted under. */
    periodKey: text().notNull(),
    currency: text().notNull(),
    wagered: money().notNull().default('0'),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The accumulator's guard: one row per player, kind and period, upserted per bet.
    uniqueIndex('promo_rank_period_wager_user_id_kind_period_key_idx').on(
      t.userId,
      t.kind,
      t.periodKey,
    ),
    // What the payout reads: everyone who wagered in the period it is settling.
    index('promo_rank_period_wager_kind_period_key_idx').on(t.kind, t.periodKey),
    check('promo_rank_period_wager_non_negative', sql`${t.wagered} >= 0`),
  ],
);

export type PromoRankPeriodWager = typeof promoRankPeriodWager.$inferSelect;

/**
 * A level-up bonus a player has earned and the payout job has yet to settle. Written in the bet's
 * transaction with the amount the tier paid at that moment, so an amount an admin fills in later
 * is never paid backwards. Unique per player and tier: a rank's bonus is earned once.
 */
export const promoRankLevelUp = pgTable(
  'promo_rank_level_up',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    // No foreign key: an admin may remove a tier the player has since climbed past, and the bonus
    // it earned is still owed. The amount is on the row, so the tier is not needed to pay it.
    tierId: uuid().notNull(),
    currency: text().notNull(),
    amount: money().notNull(),
    reachedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
    /** `granted`, or why nothing was: `restricted` for a player under an RG block. */
    outcome: text(),
    grantId: uuid(),
  },
  (t) => [
    uniqueIndex('promo_rank_level_up_user_id_tier_id_idx').on(t.userId, t.tierId),
    index('promo_rank_level_up_unsettled_idx')
      .on(t.reachedAt)
      .where(sql`${t.settledAt} is null`),
    check('promo_rank_level_up_amount_positive', sql`${t.amount} > 0`),
  ],
);

export type PromoRankLevelUp = typeof promoRankLevelUp.$inferSelect;

/**
 * Streak-wide settings, one row - the same singleton shape as `promoRankConfig`. Absent means no
 * day counts and no milestone pays: an operator who has not decided what qualifies has not
 * launched the streak.
 */
export const promoStreakConfig = pgTable('promo_streak_config', {
  id: uuid().primaryKey().defaultRandom(),
  singletonKey: text().notNull().unique().default('global'),
  currency: text().notNull(),
  dailyMinWager: money().notNull(),
  /** Products whose stakes count toward the streak. Empty counts every product. */
  eligibleProducts: text().array().notNull().default([]),
  milestones: jsonb().$type<StreakMilestone[]>().notNull().default([]),
  resetAfterDay: integer().notNull().default(30),
  updatedBy: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PromoStreakConfig = typeof promoStreakConfig.$inferSelect;

/**
 * A player's own streak state: the current run, the best run ever held, and the UTC calendar day
 * it last advanced on - the guard that keeps one qualifying day from being counted twice no
 * matter how many qualifying bets land inside it.
 */
export const promoPlayerStreak = pgTable(
  'promo_player_streak',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().unique(),
    current: integer().notNull().default(0),
    best: integer().notNull().default(0),
    lastQualifyingDay: date(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      'promo_player_streak_counts_non_negative',
      sql`${t.current} >= 0 AND ${t.best} >= 0 AND ${t.current} <= ${t.best}`,
    ),
  ],
);

export type PromoPlayerStreak = typeof promoPlayerStreak.$inferSelect;

/**
 * What a player has wagered inside one UTC calendar day, toward that day's qualifying threshold.
 * Upserted per bet, mirroring `promoRankPeriodWager` - the accumulator the daily close job and
 * the leaderboard never need, since a day answers for itself in `promoPlayerStreak` once closed.
 */
export const promoStreakDailyWager = pgTable(
  'promo_streak_daily_wager',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    day: date().notNull(),
    currency: text().notNull(),
    wagered: money().notNull().default('0'),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('promo_streak_daily_wager_user_id_day_idx').on(t.userId, t.day),
    check('promo_streak_daily_wager_non_negative', sql`${t.wagered} >= 0`),
  ],
);

export type PromoStreakDailyWager = typeof promoStreakDailyWager.$inferSelect;

/**
 * A milestone a player has reached and the payout job has yet to settle, one row per player per
 * milestone day. Deleted whenever `promo_player_streak.current` resets to zero - a missed day or
 * the milestone at `resetAfterDay` completing - so the same day can be earned again on the next
 * run without a second dimension threading every query that reads this table.
 */
export const promoStreakMilestoneGrant = pgTable(
  'promo_streak_milestone_grant',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    day: integer().notNull(),
    reachedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
    /** `granted`, or why nothing was: `restricted` for a player under an RG block. */
    outcome: text(),
  },
  (t) => [
    uniqueIndex('promo_streak_milestone_grant_user_id_day_idx').on(t.userId, t.day),
    index('promo_streak_milestone_grant_unsettled_idx')
      .on(t.reachedAt)
      .where(sql`${t.settledAt} is null`),
    check('promo_streak_milestone_grant_day_positive', sql`${t.day} > 0`),
  ],
);

export type PromoStreakMilestoneGrant = typeof promoStreakMilestoneGrant.$inferSelect;

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
  RaceEligibleProducts,
  RacePositions,
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

/**
 * A wager challenge: a fixed window over which wagering volume is ranked and a prize pool split
 * across the paid positions. Unlike the rank ladder and streak, a race carries its own explicit
 * `startAt`/`endAt` rather than an operator-wide anchor, since races are run one at a time (or
 * overlapping) on whatever schedule the operator likes.
 *
 * `closedAt` is the hard settlement flag: standings are frozen and prizes paid once, and a late
 * or retried settle-job tick after `endAt` must never recompute them - `endAt < now()` alone
 * cannot express "already settled", since a crash could leave it null after payouts landed.
 * Prospective-only editing (`RaceAdminService`) is enforced by refusing any change once this is
 * set, mirroring how `RankAdminService.set` blocks a ladder edit once a player holds state.
 */
export const promoRace = pgTable(
  'promo_race',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    currency: text().notNull(),
    startAt: timestamp({ withTimezone: true }).notNull(),
    endAt: timestamp({ withTimezone: true }).notNull(),
    prizePool: money().notNull(),
    /** `{ position, prize }[]`, validated 1..N contiguous, prizes summing to at most `prizePool`. */
    positions: jsonb().$type<RacePositions>().notNull(),
    /** Products whose stakes count toward this race. Empty counts every product. */
    eligibleProducts: text().array().notNull().default([]).$type<RaceEligibleProducts>(),
    /** Set once, by the settle job, when standings are frozen and prizes granted. */
    closedAt: timestamp({ withTimezone: true }),
    createdBy: uuid(),
    updatedBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('promo_race_prize_pool_positive', sql`${t.prizePool} > 0`),
    check('promo_race_dates_ordered', sql`${t.endAt} > ${t.startAt}`),
    index('promo_race_open_idx')
      .on(t.startAt, t.endAt)
      .where(sql`${t.closedAt} is null`),
  ],
);

export type PromoRace = typeof promoRace.$inferSelect;

/**
 * What a player has wagered inside one race, in the race's own currency - one row per player per
 * race, upserted per bet, the same accumulator shape as `promoRankPeriodWager`. `updatedAt`
 * doubles as the tie-break clock the payout job reads: two players tied on `wagered` are ranked
 * by whoever's row last moved, ie whoever reached the total first.
 */
export const promoRaceWager = pgTable(
  'promo_race_wager',
  {
    id: uuid().primaryKey().defaultRandom(),
    raceId: uuid()
      .notNull()
      .references(() => promoRace.id),
    userId: uuid().notNull(),
    currency: text().notNull(),
    wagered: money().notNull().default('0'),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('promo_race_wager_race_id_user_id_idx').on(t.raceId, t.userId),
    // The leaderboard's own query: everyone in one race, ranked by what they wagered.
    index('promo_race_wager_race_id_wagered_idx').on(t.raceId, t.wagered),
    check('promo_race_wager_non_negative', sql`${t.wagered} >= 0`),
  ],
);

export type PromoRaceWager = typeof promoRaceWager.$inferSelect;

/**
 * One prize paid to one player in one race, written once by the settle job -
 * `unique(raceId, userId)` is the idempotency guard a retried or re-ticked settlement reads
 * before crediting anything, the same "insert once, skip if present" shape
 * `promoRankLevelUp`/`promoStreakMilestoneGrant` use for their own settlement.
 */
export const promoRacePayout = pgTable(
  'promo_race_payout',
  {
    id: uuid().primaryKey().defaultRandom(),
    raceId: uuid()
      .notNull()
      .references(() => promoRace.id),
    userId: uuid().notNull(),
    position: integer().notNull(),
    amount: money().notNull(),
    currency: text().notNull(),
    settledAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    grantId: uuid(),
    /** `granted`, or why nothing was: `restricted` for a player under an RG block. */
    outcome: text().notNull(),
  },
  (t) => [
    uniqueIndex('promo_race_payout_race_id_user_id_idx').on(t.raceId, t.userId),
    index('promo_race_payout_race_id_idx').on(t.raceId),
    check('promo_race_payout_position_positive', sql`${t.position} > 0`),
    check('promo_race_payout_amount_non_negative', sql`${t.amount} >= 0`),
  ],
);

export type PromoRacePayout = typeof promoRacePayout.$inferSelect;

/**
 * A Rank Challenge tier: a lifetime real-money wagering threshold and the prize the first player
 * to cross it wins, once, forever - unlike `promoRankTier` (a repeatable ladder every player
 * climbs) or `promoRace` (a repeating leaderboard window), this is a race-to-threshold with a
 * single winner per tier. A tier carries a cash amount, a physical item description, or both
 * (`master`/`titan` combine them) - at least one of the two is required.
 */
export const promoRankChallengeTier = pgTable(
  'promo_rank_challenge_tier',
  {
    id: uuid().primaryKey().defaultRandom(),
    key: text().notNull().unique(),
    name: text().notNull(),
    position: integer().notNull().unique(),
    currency: text().notNull(),
    wagerThreshold: money().notNull(),
    cashAmount: money(),
    physicalItem: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      'promo_rank_challenge_tier_bounds',
      sql`${t.position} >= 0 AND ${t.wagerThreshold} >= 0
        AND (${t.cashAmount} is null OR ${t.cashAmount} > 0)
        AND (${t.physicalItem} is not null OR ${t.cashAmount} is not null)`,
    ),
  ],
);

export type PromoRankChallengeTier = typeof promoRankChallengeTier.$inferSelect;

/**
 * A player's lifetime real-money wagering total toward the Rank Challenge - independent of
 * `promoPlayerRank.lifetimeWagered` (the rank ladder's own accumulator, filtered by that
 * ladder's `eligibleProducts`). Every real-money wager counts here, no eligibility filter, per
 * the challenge's own "lifetime real-money wagering" rule.
 */
export const promoRankChallengeWager = pgTable(
  'promo_rank_challenge_wager',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().unique(),
    currency: text().notNull(),
    lifetimeWagered: money().notNull().default('0'),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check('promo_rank_challenge_wager_non_negative', sql`${t.lifetimeWagered} >= 0`)],
);

export type PromoRankChallengeWager = typeof promoRankChallengeWager.$inferSelect;

/**
 * The winner record for one tier - `unique(tierId)` is the whole mechanic's atomicity guard: two
 * players crossing the same tier concurrently both attempt this insert, and the unique index
 * lets exactly one land (`onConflictDoNothing`, checked via `.returning()`). `cashAmount`/
 * `physicalItem` are snapshotted from the tier at claim time so a later admin edit to the tier's
 * prize never changes what a past winner was actually granted (prospective-only, the same rule
 * `promoRankLevelUp` follows for its own amount). Settled by a payout job, mirroring
 * `promoRankLevelUp`/`promoStreakMilestoneGrant`'s own unsettled-row pattern, rather than being
 * credited inline in the same transaction that detects the crossing.
 */
export const promoRankChallengeClaim = pgTable(
  'promo_rank_challenge_claim',
  {
    id: uuid().primaryKey().defaultRandom(),
    tierId: uuid().notNull(),
    userId: uuid().notNull(),
    currency: text().notNull(),
    cashAmount: money(),
    physicalItem: text(),
    claimedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
    /** `granted`, or why the cash part was not: `restricted` for a player under an RG block. */
    outcome: text(),
    cashGrantId: uuid(),
    physicalFulfilledAt: timestamp({ withTimezone: true }),
    physicalFulfilledBy: uuid(),
    physicalFulfillmentNote: text(),
  },
  (t) => [
    uniqueIndex('promo_rank_challenge_claim_tier_id_idx').on(t.tierId),
    index('promo_rank_challenge_claim_unsettled_idx')
      .on(t.claimedAt)
      .where(sql`${t.settledAt} is null`),
    index('promo_rank_challenge_claim_fulfilment_queue_idx')
      .on(t.claimedAt)
      .where(sql`${t.physicalItem} is not null AND ${t.physicalFulfilledAt} is null`),
  ],
);

export type PromoRankChallengeClaim = typeof promoRankChallengeClaim.$inferSelect;

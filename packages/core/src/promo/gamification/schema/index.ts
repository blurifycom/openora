import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
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
  RAKEBACK_BASES,
  type WagerProduct,
} from '@openora/core/contracts';
import {
  DEFAULT_RANK_PERK_PRODUCTS,
  RAKEBACK_ACCRUAL_STATUSES,
  RAKEBACK_CLAIM_OUTCOMES,
  RANK_PERIODIC_REWARD_KINDS,
  RANK_PERIODIC_REWARD_STATUSES,
  STREAK_CURRENCY,
  STREAK_RAKEBACK_MODES,
} from '../contract/index.js';
import type {
  RaceEligibleProducts,
  RacePositions,
  RankConfig,
  RankPayoutAnchors,
  RankPayoutKind,
  RankPeriodicRewardTerms,
  RankRewardTerms,
  StreakFixedReward,
  StreakGrantOutcome,
  StreakRakebackMilestone,
} from '../contract/index.js';

const money = () => decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE });
const percent = () =>
  decimal({ precision: CONTRIBUTION_PERCENT_PRECISION, scale: CONTRIBUTION_PERCENT_SCALE });

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
    dailyBonusPercent: percent(),
    weeklyBonusPercent: percent(),
    monthlyBonusPercent: percent(),
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
    check(
      'promo_rank_tier_bonus_percent_bounds',
      sql`(${t.dailyBonusPercent} is null OR (${t.dailyBonusPercent} > 0 AND ${t.dailyBonusPercent} <= 100))
        AND (${t.weeklyBonusPercent} is null OR (${t.weeklyBonusPercent} > 0 AND ${t.weeklyBonusPercent} <= 100))
        AND (${t.monthlyBonusPercent} is null OR (${t.monthlyBonusPercent} > 0 AND ${t.monthlyBonusPercent} <= 100))`,
    ),
    check(
      'promo_rank_tier_total_percent',
      sql`${t.rakebackPercent} + coalesce(${t.dailyBonusPercent}, 0)
        + coalesce(${t.weeklyBonusPercent}, 0) + coalesce(${t.monthlyBonusPercent}, 0) <= 100`,
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
    announcedTierId: uuid(),
    lastWageredAt: timestamp({ withTimezone: true }),
    rakebackBoostPercent: decimal({
      precision: CONTRIBUTION_PERCENT_PRECISION,
      scale: CONTRIBUTION_PERCENT_SCALE,
    }),
    rakebackBoostExpiresAt: timestamp({ withTimezone: true }),
    lastClaimableNotifiedAt: timestamp({ withTimezone: true }),
    rakebackReminderCheckedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('promo_player_rank_lifetime_wagered_non_negative', sql`${t.lifetimeWagered} >= 0`),
    index('promo_player_rank_unannounced_idx')
      .on(t.userId)
      .where(sql`${t.announcedTierId} IS DISTINCT FROM ${t.tierId}`),
  ],
);

export type PromoPlayerRank = typeof promoPlayerRank.$inferSelect;

export type RankRewards = RankConfig['rewards'];
export type { RankRewardTerms };

export const promoRankConfig = pgTable('promo_rank_config', {
  id: uuid().primaryKey().defaultRandom(),
  singletonKey: text().notNull().unique().default('global'),
  eligibleProducts: text().array().notNull(),
  rakebackEligibleProducts: text()
    .array()
    .$type<WagerProduct[]>()
    .notNull()
    .default([...DEFAULT_RANK_PERK_PRODUCTS]),
  rankChallengeEligibleProducts: text()
    .array()
    .$type<WagerProduct[]>()
    .notNull()
    .default([...DEFAULT_RANK_PERK_PRODUCTS]),
  rewards: jsonb().$type<RankRewards>().notNull().default({}),
  payoutCurrency: text(),
  payInPlayerCurrency: boolean().notNull().default(false),
  periodicRequiresActivity: boolean().notNull().default(true),
  periodicMinimumWager: money(),
  payoutAnchors: jsonb()
    .$type<RankPayoutAnchors>()
    .notNull()
    .default({ dailyHour: 0, weeklyDay: 1, monthlyDay: 1 }),
  paidThrough: jsonb().$type<Partial<Record<RankPayoutKind, string>>>().notNull().default({}),
  updatedBy: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PromoRankConfig = typeof promoRankConfig.$inferSelect;

export const promoRankPeriodWager = pgTable(
  'promo_rank_period_wager',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    kind: text().$type<RankPayoutKind>().notNull(),
    periodKey: text().notNull(),
    currency: text().notNull(),
    wagered: money().notNull().default('0'),
    margin: money().notNull().default('0'),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('promo_rank_period_wager_user_id_kind_period_key_idx').on(
      t.userId,
      t.kind,
      t.periodKey,
    ),
    index('promo_rank_period_wager_kind_period_key_idx').on(t.kind, t.periodKey),
    index('promo_rank_period_wager_kind_updated_at_idx').on(t.kind, t.updatedAt),
    check('promo_rank_period_wager_non_negative', sql`${t.wagered} >= 0`),
    check('promo_rank_period_wager_margin_non_negative', sql`${t.margin} >= 0`),
  ],
);

export type PromoRankPeriodWager = typeof promoRankPeriodWager.$inferSelect;

export const promoRankRoundWager = pgTable(
  'promo_rank_round_wager',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    providerName: text().notNull(),
    externalRoundId: text().notNull(),
    currency: text().notNull(),
    ladderCurrency: text().notNull(),
    stake: money().notNull(),
    margin: money().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('promo_rank_round_wager_round_idx').on(
      t.userId,
      t.providerName,
      t.currency,
      t.externalRoundId,
      t.ladderCurrency,
    ),
    index('promo_rank_round_wager_created_idx').on(t.createdAt),
    check('promo_rank_round_wager_non_negative', sql`${t.stake} >= 0 AND ${t.margin} >= 0`),
  ],
);

export const promoRankLevelUp = pgTable(
  'promo_rank_level_up',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    tierId: uuid().notNull(),
    currency: text().notNull(),
    amount: money().notNull(),
    reachedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
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

export const promoStreakConfig = pgTable('promo_streak_config', {
  id: uuid().primaryKey().defaultRandom(),
  singletonKey: text().notNull().unique().default('global'),
  enabled: boolean().notNull().default(false),
  currency: text().notNull().default(STREAK_CURRENCY),
  dailyMinWager: money().notNull(),
  eligibleProducts: text().array().notNull(),
  rakebackMilestones: jsonb().$type<StreakRakebackMilestone[]>().notNull().default([]),
  fixedRewards: jsonb().$type<StreakFixedReward[]>().notNull().default([]),
  milestones: jsonb().notNull().default([]),
  resetAfterDay: integer().notNull().default(30),
  updatedBy: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PromoStreakConfig = typeof promoStreakConfig.$inferSelect;

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

export const promoStreakRoundWager = pgTable(
  'promo_streak_round_wager',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    providerName: text().notNull(),
    currency: text().notNull(),
    externalRoundId: text().notNull(),
    day: date().notNull(),
    stake: money().notNull(),
    wagered: money().notNull(),
  },
  (t) => [
    uniqueIndex('promo_streak_round_wager_round_idx').on(
      t.userId,
      t.providerName,
      t.currency,
      t.externalRoundId,
      t.day,
    ),
    index('promo_streak_round_wager_day_idx').on(t.day),
    check('promo_streak_round_wager_non_negative', sql`${t.stake} >= 0 AND ${t.wagered} >= 0`),
  ],
);

export const promoStreakMilestoneGrant = pgTable(
  'promo_streak_milestone_grant',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    day: integer().notNull(),
    reachedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
    outcome: text().$type<StreakGrantOutcome>(),
    announcedAt: timestamp({ withTimezone: true }),
    amount: money(),
    rolloverMultiplier: money(),
    claimExpiryDays: integer(),
    maxBet: money(),
    expiresAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('promo_streak_milestone_grant_user_id_day_idx').on(t.userId, t.day),
    index('promo_streak_milestone_grant_unsettled_idx')
      .on(t.reachedAt)
      .where(sql`${t.settledAt} is null`),
    check('promo_streak_milestone_grant_day_positive', sql`${t.day} > 0`),
    check(
      'promo_streak_milestone_grant_terms_valid',
      sql`(${t.amount} is null OR ${t.amount} > 0)
        AND (${t.rolloverMultiplier} is null OR ${t.rolloverMultiplier} > 0)
        AND (${t.claimExpiryDays} is null OR ${t.claimExpiryDays} > 0)
        AND (${t.maxBet} is null OR ${t.maxBet} > 0)`,
    ),
  ],
);

export type PromoStreakMilestoneGrant = typeof promoStreakMilestoneGrant.$inferSelect;

export const promoRace = pgTable(
  'promo_race',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    currency: text().notNull(),
    startAt: timestamp({ withTimezone: true }).notNull(),
    endAt: timestamp({ withTimezone: true }).notNull(),
    prizePool: money().notNull(),
    positions: jsonb().$type<RacePositions>().notNull(),
    eligibleProducts: text().array().notNull().$type<RaceEligibleProducts>(),
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
    check('promo_race_eligible_products_set', sql`cardinality(${t.eligibleProducts}) > 0`),
    index('promo_race_open_idx')
      .on(t.startAt, t.endAt)
      .where(sql`${t.closedAt} is null`),
  ],
);

export type PromoRace = typeof promoRace.$inferSelect;

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
    index('promo_race_wager_race_id_wagered_idx').on(t.raceId, t.wagered),
    check('promo_race_wager_non_negative', sql`${t.wagered} >= 0`),
  ],
);

export type PromoRaceWager = typeof promoRaceWager.$inferSelect;

export const promoRaceRoundWager = pgTable(
  'promo_race_round_wager',
  {
    id: uuid().primaryKey().defaultRandom(),
    raceId: uuid()
      .notNull()
      .references(() => promoRace.id, { onDelete: 'cascade' }),
    userId: uuid().notNull(),
    providerName: text().notNull(),
    currency: text().notNull(),
    externalRoundId: text().notNull(),
    stake: money().notNull(),
    wagered: money().notNull(),
  },
  (t) => [
    uniqueIndex('promo_race_round_wager_round_idx').on(
      t.raceId,
      t.userId,
      t.providerName,
      t.currency,
      t.externalRoundId,
    ),
    index('promo_race_round_wager_user_id_external_round_id_idx').on(t.userId, t.externalRoundId),
    check('promo_race_round_wager_non_negative', sql`${t.stake} >= 0 AND ${t.wagered} >= 0`),
  ],
);

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

export const promoRakebackBasisEnum = pgEnum('promo_rakeback_basis', RAKEBACK_BASES);
export const promoStreakRakebackModeEnum = pgEnum(
  'promo_streak_rakeback_mode',
  STREAK_RAKEBACK_MODES,
);
export const promoRakebackAccrualStatusEnum = pgEnum(
  'promo_rakeback_accrual_status',
  RAKEBACK_ACCRUAL_STATUSES,
);
export const promoRakebackClaimOutcomeEnum = pgEnum(
  'promo_rakeback_claim_outcome',
  RAKEBACK_CLAIM_OUTCOMES,
);

export const promoRakebackAccrual = pgTable(
  'promo_rakeback_accrual',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    currency: text().notNull(),
    amount: money().notNull(),
    stake: money().notNull(),
    rolledBackStake: money().notNull().default('0'),
    basis: promoRakebackBasisEnum().notNull(),
    rtp: decimal({ precision: 19, scale: 18 }),
    ratePercent: percent().notNull(),
    boostPercent: percent().notNull(),
    streakMode: promoStreakRakebackModeEnum(),
    streakPercent: percent(),
    gameId: text(),
    providerGameKey: text(),
    providerName: text(),
    externalRoundId: text(),
    status: promoRakebackAccrualStatusEnum().notNull().default('accrued'),
    claimId: uuid().references(() => promoRakebackClaim.id),
    voidedBy: uuid(),
    voidReason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('promo_rakeback_accrual_user_id_status_idx').on(t.userId, t.status),
    index('promo_rakeback_accrual_round_idx').on(
      t.userId,
      t.providerName,
      t.currency,
      t.externalRoundId,
    ),
    index('promo_rakeback_accrual_claim_id_idx').on(t.claimId),
    index('promo_rakeback_accrual_unclaimed_idx')
      .on(t.currency, t.userId)
      .where(sql`${t.status} = 'accrued'`),
    index('promo_rakeback_accrual_created_at_idx').on(t.createdAt, t.id),
    index('promo_rakeback_accrual_claimed_settled_at_idx')
      .on(t.settledAt)
      .where(sql`${t.status} = 'claimed'`),
    check(
      'promo_rakeback_accrual_bounds',
      sql`${t.amount} > 0 AND ${t.stake} >= 0 AND ${t.rolledBackStake} >= 0 AND ${t.rolledBackStake} <= ${t.stake} AND (${t.rtp} is null OR (${t.rtp} > 0 AND ${t.rtp} <= 1))`,
    ),
    check(
      'promo_rakeback_accrual_streak',
      sql`(${t.streakMode} is null) = (${t.streakPercent} is null)`,
    ),
    check(
      'promo_rakeback_accrual_settlement',
      sql`(${t.claimId} is null OR ${t.status} = 'claimed')
        AND (${t.status} = 'voided') = (${t.voidReason} is not null)`,
    ),
  ],
);

export type PromoRakebackAccrual = typeof promoRakebackAccrual.$inferSelect;

export const promoRakebackClaim = pgTable(
  'promo_rakeback_claim',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    idempotencyKey: text().notNull(),
    outcome: promoRakebackClaimOutcomeEnum().notNull(),
    settledAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('promo_rakeback_claim_user_id_idempotency_key_idx').on(t.userId, t.idempotencyKey),
  ],
);

export type PromoRakebackClaim = typeof promoRakebackClaim.$inferSelect;

export const promoRakebackClaimPayout = pgTable(
  'promo_rakeback_claim_payout',
  {
    id: uuid().primaryKey().defaultRandom(),
    claimId: uuid()
      .notNull()
      .references(() => promoRakebackClaim.id),
    userId: uuid().notNull(),
    currency: text().notNull(),
    amount: money().notNull(),
    transactionId: uuid().notNull(),
  },
  (t) => [
    uniqueIndex('promo_rakeback_claim_payout_claim_id_currency_idx').on(t.claimId, t.currency),
    index('promo_rakeback_claim_payout_user_id_currency_idx').on(t.userId, t.currency),
    check('promo_rakeback_claim_payout_amount_positive', sql`${t.amount} > 0`),
  ],
);

export const promoRankPeriodicRewardKindEnum = pgEnum(
  'promo_rank_periodic_reward_kind',
  RANK_PERIODIC_REWARD_KINDS,
);
export const promoRankPeriodicRewardStatusEnum = pgEnum(
  'promo_rank_periodic_reward_status',
  RANK_PERIODIC_REWARD_STATUSES,
);

export const promoRankPeriodicReward = pgTable(
  'promo_rank_periodic_reward',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    kind: promoRankPeriodicRewardKindEnum().notNull(),
    periodKey: text().notNull(),
    periodStart: timestamp({ withTimezone: true }).notNull(),
    periodEnd: timestamp({ withTimezone: true }).notNull(),
    tierId: uuid().notNull(),
    ladderCurrency: text().notNull(),
    ladderAmount: money().notNull(),
    currency: text().notNull(),
    amount: money().notNull(),
    status: promoRankPeriodicRewardStatusEnum().notNull().default('claimable'),
    idempotencyKey: text(),
    transactionId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('promo_rank_periodic_reward_user_id_kind_period_key_idx').on(
      t.userId,
      t.kind,
      t.periodKey,
    ),
    uniqueIndex('promo_rank_periodic_reward_user_id_idempotency_key_idx')
      .on(t.userId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('promo_rank_periodic_reward_user_id_status_idx').on(t.userId, t.status),
    index('promo_rank_periodic_reward_claimable_idx')
      .on(t.currency, t.userId)
      .where(sql`${t.status} = 'claimable'`),
    index('promo_rank_periodic_reward_created_at_idx').on(t.createdAt),
    index('promo_rank_periodic_reward_settled_at_idx')
      .on(t.settledAt)
      .where(sql`${t.status} <> 'claimable'`),
    check(
      'promo_rank_periodic_reward_amounts_positive',
      sql`${t.amount} > 0 AND ${t.ladderAmount} > 0`,
    ),
    check(
      'promo_rank_periodic_reward_settlement',
      sql`(${t.status} = 'claimable') = (${t.settledAt} is null) AND (${t.status} = 'claimable') = (${t.transactionId} is null)`,
    ),
  ],
);

export type PromoRankPeriodicReward = typeof promoRankPeriodicReward.$inferSelect;

export const promoRankPeriodPayout = pgTable(
  'promo_rank_period_payout',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: promoRankPeriodicRewardKindEnum().notNull(),
    periodKey: text().notNull(),
    terms: jsonb().$type<RankPeriodicRewardTerms>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('promo_rank_period_payout_kind_period_key_idx').on(t.kind, t.periodKey)],
);

import { sql } from 'drizzle-orm';
import {
  check,
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
import type { RankConfig } from '../contract/index.js';

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
  updatedBy: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PromoRankConfig = typeof promoRankConfig.$inferSelect;

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

import { sql } from 'drizzle-orm';
import {
  check,
  decimal,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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

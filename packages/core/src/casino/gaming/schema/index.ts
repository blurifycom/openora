import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  boolean,
  decimal,
  timestamp,
  pgEnum,
  index,
  integer,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import {
  GameCategoryTranslationsSchema,
  GAME_TYPES,
  MONEY_PRECISION,
  MONEY_SCALE,
} from '@openora/core/contracts';
import { zodJsonb } from '@openora/core/server';
import { GAME_ROUND_STATUSES } from '../contract/index.js';

// Derives from the contract tuple so the Zod schema and DB enum can never drift.
export const gameRoundStatusEnum = pgEnum('game_round_status', GAME_ROUND_STATUSES);
// GAME_TYPES is hoisted to core contracts (not module-local like GAME_ROUND_STATUSES)
// because ADMIN_GAME_REPORTING (contracts/adapters, isomorphic) and admin-console's
// contract both need the same type - see contracts/schemas/game.ts.
export const gameTypeEnum = pgEnum('game_type', GAME_TYPES);

export const gameProvider = pgTable(
  'game_provider',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    // The aggregator's studio id (eg EventMatrix's id for Pragmatic Play).
    // NULL = direct-only integration with no aggregator mapping.
    aggregatorVendorId: text(),
    logoUrl: text(),
    isActive: boolean().notNull().default(false),
    metadata: jsonb(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('game_provider_slug_key').on(t.slug),
    uniqueIndex('game_provider_aggregator_vendor_id_key').on(t.aggregatorVendorId),
  ],
);

export const gameCategory = pgTable(
  'game_category',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    translations: zodJsonb(GameCategoryTranslationsSchema, 'game_category.translations')()
      .notNull()
      .default({}),
    icon: text(),
    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('game_category_slug_key').on(t.slug)],
);

export const game = pgTable(
  'game',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull(),
    providerId: uuid()
      .notNull()
      .references(() => gameProvider.id),
    aggregator: text().notNull(),
    gameType: gameTypeEnum().notNull().default('casino'),
    thumbnailUrl: text(),
    isActive: boolean().notNull().default(false),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Legacy pre-0003 free-text columns. Retained (unread, unwritten by new code)
    // so old releases keep working until a follow-up drop migration lands.
    // Never read or write from new code.
    provider: text(),
    category: text(),
  },
  (t) => [
    uniqueIndex('game_slug_key').on(t.slug),
    index('game_provider_id_idx').on(t.providerId),
    index('game_aggregator_idx').on(t.aggregator),
  ],
);

// A game can sit in multiple categories (eg 'table games' + 'blackjack').
export const gameCategoryGame = pgTable(
  'game_category_game',
  {
    id: uuid().primaryKey().defaultRandom(),
    gameId: uuid()
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    categoryId: uuid()
      .notNull()
      .references(() => gameCategory.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('game_category_game_key').on(t.gameId, t.categoryId),
    index('game_category_game_category_id_idx').on(t.categoryId),
  ],
);

export const gameRound = pgTable(
  'game_round',
  {
    id: uuid().primaryKey().defaultRandom(),
    gameId: uuid()
      .notNull()
      .references(() => game.id),
    userId: uuid().notNull(),
    status: gameRoundStatusEnum().notNull().default('active'),
    betAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull().default('0'),
    winAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull().default('0'),
    currency: text().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp({ withTimezone: true }),
    externalRoundId: text(),
  },
  (t) => [
    index('game_round_user_id_idx').on(t.userId),
    index('game_round_game_id_started_at_idx').on(t.gameId, t.startedAt),
    index('game_round_started_at_idx').on(t.startedAt),
    uniqueIndex('game_round_external_round_id_idx')
      .on(t.externalRoundId)
      .where(sql`${t.externalRoundId} IS NOT NULL`),
  ],
);

export type Game = typeof game.$inferSelect;
export type GameRound = typeof gameRound.$inferSelect;
export type GameProvider = typeof gameProvider.$inferSelect;
export type GameCategory = typeof gameCategory.$inferSelect;
export type GameCategoryGame = typeof gameCategoryGame.$inferSelect;

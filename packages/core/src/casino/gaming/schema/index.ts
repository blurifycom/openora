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
  DEFAULT_GAME_TAG_BADGE_SETTINGS,
  GameCategoryTranslationsSchema,
  GAME_TAG_TYPES,
  GAME_TAG_VISIBILITIES,
  GAME_TYPES,
  GameTagBadgeSettingsSchema,
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
export const gameTagTypeEnum = pgEnum('game_tag_type', GAME_TAG_TYPES);
export const gameTagVisibilityEnum = pgEnum('game_tag_visibility', GAME_TAG_VISIBILITIES);

export const gameProvider = pgTable(
  'game_provider',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    logoUrl: text(),
    isActive: boolean().notNull().default(false),
    metadata: jsonb(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('game_provider_slug_key').on(t.slug)],
);

export const gameProviderAggregatorMapping = pgTable(
  'game_provider_aggregator_mapping',
  {
    id: uuid().primaryKey().defaultRandom(),
    providerId: uuid()
      .notNull()
      .references(() => gameProvider.id, { onDelete: 'cascade' }),
    aggregator: text().notNull(),
    vendorId: text().notNull(),
  },
  (t) => [
    uniqueIndex('game_provider_aggregator_mapping_provider_aggregator_key').on(
      t.providerId,
      t.aggregator,
    ),
    uniqueIndex('game_provider_aggregator_mapping_aggregator_vendor_id_key').on(
      t.aggregator,
      t.vendorId,
    ),
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
    // so old releases keep working until a follow-up drop migration lands; the
    // game_legacy_* triggers in migration 0005 derive slug/providerId/aggregator
    // and the category link for their inserts, and drop with these columns.
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

export const gameTag = pgTable(
  'game_tag',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    type: gameTagTypeEnum().notNull().default('custom'),
    visibility: gameTagVisibilityEnum().notNull().default('invisible'),
    badgeSettings: zodJsonb(GameTagBadgeSettingsSchema, 'game_tag.badge_settings')()
      .notNull()
      .default(DEFAULT_GAME_TAG_BADGE_SETTINGS),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('game_tag_name_key').on(t.name),
    index('game_tag_type_idx').on(t.type),
    index('game_tag_visibility_idx').on(t.visibility),
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

export const gameTagGame = pgTable(
  'game_tag_game',
  {
    id: uuid().primaryKey().defaultRandom(),
    gameId: uuid()
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    tagId: uuid()
      .notNull()
      .references(() => gameTag.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('game_tag_game_key').on(t.gameId, t.tagId),
    index('game_tag_game_tag_id_idx').on(t.tagId),
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
export type GameProviderAggregatorMapping = typeof gameProviderAggregatorMapping.$inferSelect;
export type GameCategory = typeof gameCategory.$inferSelect;
export type GameCategoryGame = typeof gameCategoryGame.$inferSelect;
export type GameTag = typeof gameTag.$inferSelect;
export type GameTagGame = typeof gameTagGame.$inferSelect;

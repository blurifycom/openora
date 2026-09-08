import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import type { LobbySectionConfig } from '@openora/core/contracts';

export const lobbyCategory = pgTable(
  'lobby_category',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull(),
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('lobby_cat_slug_key').on(t.slug)],
);

export const lobbyCategoryGame = pgTable(
  'lobby_category_game',
  {
    id: uuid().primaryKey().defaultRandom(),
    categoryId: uuid()
      .notNull()
      .references(() => lobbyCategory.id, { onDelete: 'cascade' }),
    gameId: uuid().notNull(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [index('lobby_cat_game_category_id_idx').on(t.categoryId)],
);

export const featuredSlot = pgTable('featured_slot', {
  id: uuid().primaryKey().defaultRandom(),
  gameId: uuid().notNull(),
  title: text().notNull(),
  placement: text().notNull(),
  sortOrder: integer().notNull().default(0),
  isActive: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const lobbyLayout = pgTable(
  'lobby_layout',
  {
    id: uuid().primaryKey().defaultRandom(),
    layoutKey: text().notNull().default('global'),
    version: integer().notNull().default(0),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('lobby_layout_layout_key_key').on(t.layoutKey)],
);

export const lobbySection = pgTable(
  'lobby_section',
  {
    id: uuid().primaryKey().defaultRandom(),
    type: text().notNull(),
    config: jsonb().$type<LobbySectionConfig>().notNull(),
    sortOrder: integer().notNull().default(0),
    isEnabled: boolean().notNull().default(true),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lobby_section_sort_order_idx').on(t.sortOrder)],
);

export type LobbySection = typeof lobbySection.$inferSelect;
export type LobbyLayout = typeof lobbyLayout.$inferSelect;
export type LobbyCategory = typeof lobbyCategory.$inferSelect;
export type LobbyCategoryGame = typeof lobbyCategoryGame.$inferSelect;
export type FeaturedSlot = typeof featuredSlot.$inferSelect;

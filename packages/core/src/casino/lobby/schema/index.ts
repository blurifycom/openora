import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const lobbyCategory = pgTable(
  'lobby_category',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull(),
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp().notNull().defaultNow(),
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
  createdAt: timestamp().notNull().defaultNow(),
});

export type LobbyCategory = typeof lobbyCategory.$inferSelect;
export type LobbyCategoryGame = typeof lobbyCategoryGame.$inferSelect;
export type FeaturedSlot = typeof featuredSlot.$inferSelect;

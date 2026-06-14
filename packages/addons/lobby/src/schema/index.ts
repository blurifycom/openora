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
  'LobbyCategory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenantId').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    sortOrder: integer('sortOrder').notNull().default(0),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lobby_cat_tenantId_slug_key').on(t.tenantId, t.slug),
    index('lobby_cat_tenantId_idx').on(t.tenantId),
  ],
);

export const lobbyCategoryGame = pgTable(
  'LobbyCategoryGame',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('categoryId')
      .notNull()
      .references(() => lobbyCategory.id, { onDelete: 'cascade' }),
    gameId: uuid('gameId').notNull(),
    sortOrder: integer('sortOrder').notNull().default(0),
  },
  (t) => [index('lobby_cat_game_categoryId_idx').on(t.categoryId)],
);

export const featuredSlot = pgTable(
  'FeaturedSlot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenantId').notNull(),
    gameId: uuid('gameId').notNull(),
    title: text('title').notNull(),
    placement: text('placement').notNull(),
    sortOrder: integer('sortOrder').notNull().default(0),
    isActive: boolean('isActive').notNull().default(true),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [index('featured_slot_tenantId_idx').on(t.tenantId)],
);

export type LobbyCategory = typeof lobbyCategory.$inferSelect;
export type LobbyCategoryGame = typeof lobbyCategoryGame.$inferSelect;
export type FeaturedSlot = typeof featuredSlot.$inferSelect;

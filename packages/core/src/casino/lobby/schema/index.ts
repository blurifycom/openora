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

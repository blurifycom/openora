import {
  pgTable,
  uuid,
  text,
  boolean,
  decimal,
  timestamp,
  pgEnum,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { GAME_ROUND_STATUSES } from '../contract/index.js';

// Derives from the contract tuple so the Zod schema and DB enum can never drift.
export const gameRoundStatusEnum = pgEnum('game_round_status', GAME_ROUND_STATUSES);

export const game = pgTable('game', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  provider: text().notNull(),
  category: text().notNull(),
  thumbnailUrl: text(),
  isActive: boolean().notNull().default(true),
  metadata: jsonb(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const gameRound = pgTable(
  'game_round',
  {
    id: uuid().primaryKey().defaultRandom(),
    gameId: uuid()
      .notNull()
      .references(() => game.id),
    userId: uuid().notNull(),
    status: gameRoundStatusEnum().notNull().default('active'),
    betAmount: decimal({ precision: 18, scale: 2 }).notNull().default('0'),
    winAmount: decimal({ precision: 18, scale: 2 }).notNull().default('0'),
    currency: text().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index('game_round_user_id_idx').on(t.userId)],
);

export type Game = typeof game.$inferSelect;
export type GameRound = typeof gameRound.$inferSelect;

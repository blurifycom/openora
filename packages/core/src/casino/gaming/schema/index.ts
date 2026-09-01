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
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import { GAME_TYPES } from '@openora/core/contracts';
import { GAME_ROUND_STATUSES } from '../contract/index.js';

// Derives from the contract tuple so the Zod schema and DB enum can never drift.
export const gameRoundStatusEnum = pgEnum('game_round_status', GAME_ROUND_STATUSES);
// GAME_TYPES is hoisted to core contracts (not module-local like GAME_ROUND_STATUSES)
// because ADMIN_GAME_REPORTING (contracts/adapters, isomorphic) and admin-console's
// contract both need the same type - see contracts/schemas/game.ts.
export const gameTypeEnum = pgEnum('game_type', GAME_TYPES);

export const game = pgTable('game', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  provider: text().notNull(),
  category: text().notNull(),
  gameType: gameTypeEnum().notNull().default('casino'),
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
    // The aggregator-side round id a synchronous wallet-callback bridge accumulates bet/win
    // deltas onto (see GamingService.accumulateExternalRound). Null for a round started
    // in-platform via startRound - those are identified by their own `id`.
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

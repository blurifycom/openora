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

export const gameRoundStatusEnum = pgEnum('GameRoundStatus', ['active', 'completed', 'cancelled']);

export const game = pgTable('Game', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  category: text('category').notNull(),
  thumbnailUrl: text('thumbnailUrl'),
  isActive: boolean('isActive').notNull().default(true),
  metadata: jsonb('metadata'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
});

export const gameRound = pgTable(
  'GameRound',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('gameId')
      .notNull()
      .references(() => game.id),
    userId: uuid('userId').notNull(),
    status: gameRoundStatusEnum('status').notNull().default('active'),
    betAmount: decimal('betAmount').notNull().default('0'),
    winAmount: decimal('winAmount').notNull().default('0'),
    currency: text('currency').notNull(),
    startedAt: timestamp('startedAt').notNull().defaultNow(),
    endedAt: timestamp('endedAt'),
  },
  (t) => [index('game_round_userId_idx').on(t.userId)],
);

export type Game = typeof game.$inferSelect;
export type GameRound = typeof gameRound.$inferSelect;

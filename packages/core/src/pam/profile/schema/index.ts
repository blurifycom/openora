import { pgTable, uuid, text, integer, decimal, timestamp, index } from 'drizzle-orm/pg-core';

// Read by @oss-addons/player-management via the /schema subpath (add-on->core read, allowed per ADR-0020).
export const player = pgTable(
  'player',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('userId').notNull().unique(),
    displayName: text('displayName').notNull(),
    country: text('country'),
    currency: text('currency').notNull().default('USD'),
    language: text('language').notNull().default('en'),
    status: text('status').notNull().default('active'),
    kycStatus: text('kycStatus').notNull().default('pending'),
    level: integer('level').notNull().default(1),
    totalWagered: decimal('totalWagered', { precision: 18, scale: 2 }).notNull().default('0'),
    totalDeposits: decimal('totalDeposits', { precision: 18, scale: 2 }).notNull().default('0'),
    lastSeenAt: timestamp('lastSeenAt'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('player_status_idx').on(t.status), index('player_createdAt_idx').on(t.createdAt)],
);

export type Player = typeof player.$inferSelect;

import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, decimal, timestamp, index } from 'drizzle-orm/pg-core';

// Read by @blurifycom-addons/player-management via the /schema subpath (add-on->core read, allowed per ADR-0020).
export const player = pgTable(
  'player',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().unique('player_user_id_unique'),
    displayName: text().notNull(),
    country: text(),
    currency: text().notNull().default('USD'),
    language: text().notNull().default('en'),
    status: text().notNull().default('active'),
    kycStatus: text().notNull().default('pending'),
    level: integer().notNull().default(1),
    totalWagered: decimal({ precision: 18, scale: 2 }).notNull().default('0'),
    totalDeposits: decimal({ precision: 18, scale: 2 }).notNull().default('0'),
    lastSeenAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('player_status_idx').on(t.status),
    index('player_created_at_idx').on(t.createdAt),
    // Trigram GIN index so the back-office player search (`ILIKE '%term%'` on
    // display_name) is index-backed instead of a seq scan. Requires pg_trgm.
    index('player_name_trgm_idx').using('gin', sql`${t.displayName} gin_trgm_ops`),
  ],
);

export type Player = typeof player.$inferSelect;

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

export const playerNote = pgTable('player_note', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerId: uuid('player_id').notNull(),
  actorId: uuid('actor_id').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export type PlayerNote = typeof playerNote.$inferSelect;

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

export const playerNote = pgTable('player_note', {
  id: uuid().primaryKey().defaultRandom(),
  playerId: uuid().notNull(),
  actorId: uuid().notNull(),
  content: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export type PlayerNote = typeof playerNote.$inferSelect;

import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const playerNote = pgTable(
  'player_note',
  {
    id: uuid().primaryKey().defaultRandom(),
    playerId: uuid().notNull(),
    actorId: uuid().notNull(),
    content: text().notNull(),
    // The agent proposal whose execution wrote the note; null for a note an admin wrote. Bare
    // uuid, no .references: core stores no proposals.
    proposalId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('player_note_proposal_id_idx')
      .on(t.proposalId)
      .where(sql`${t.proposalId} IS NOT NULL`),
  ],
);

export type PlayerNote = typeof playerNote.$inferSelect;

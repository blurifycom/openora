import { sql } from 'drizzle-orm';
import { pgTable, uuid, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';

export const friendship = pgTable(
  'friendship',
  {
    id: uuid().primaryKey().defaultRandom(),
    requesterId: uuid().notNull(), // bare id - cross-module (user from pam), no FK
    addresseeId: uuid().notNull(), // bare id - cross-module (user from pam), no FK
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
    acceptedAt: timestamp({ withTimezone: true }),
    refusedAt: timestamp({ withTimezone: true }),
    removedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('friendship_pair_key')
      .on(
        sql`LEAST(${t.requesterId}, ${t.addresseeId})`,
        sql`GREATEST(${t.requesterId}, ${t.addresseeId})`,
      )
      .where(sql`${t.removedAt} IS NULL`),
    index('friendship_addressee_idx').on(t.addresseeId),
    index('friendship_requester_idx').on(t.requesterId),
    check(
      'friendship_one_decision_key',
      sql`NOT (${t.acceptedAt} IS NOT NULL AND ${t.refusedAt} IS NOT NULL)`,
    ),
    check(
      'friendship_removed_requires_accepted_key',
      sql`NOT (${t.removedAt} IS NOT NULL AND ${t.acceptedAt} IS NULL)`,
    ),
  ],
);
export type Friendship = typeof friendship.$inferSelect;

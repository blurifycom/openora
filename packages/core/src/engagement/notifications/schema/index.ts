import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const notification = pgTable(
  'notification',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    type: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    data: jsonb().$type<Record<string, string>>(),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    eventId: uuid(),
  },
  (t) => [
    index('notification_user_id_idx').on(t.userId),
    uniqueIndex('notification_event_id_idx').on(t.eventId),
  ],
);

export type Notification = typeof notification.$inferSelect;

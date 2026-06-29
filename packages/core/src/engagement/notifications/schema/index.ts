import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const notification = pgTable(
  'notification',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    type: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_user_id_idx').on(t.userId)],
);

export type Notification = typeof notification.$inferSelect;

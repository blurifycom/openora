import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('userId').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    readAt: timestamp('readAt'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [index('notification_userId_idx').on(t.userId)],
);

export type Notification = typeof notification.$inferSelect;

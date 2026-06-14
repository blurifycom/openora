import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Tenant scope for RLS isolation (ADR-0018). Notifications carry PII (title /
    // body), so this table is RLS-enforced like every other scoped table.
    tenantId: text('tenantId').notNull().default('default'),
    userId: uuid('userId').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    readAt: timestamp('readAt'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('notification_userId_idx').on(t.userId),
    index('notification_tenantId_idx').on(t.tenantId),
  ],
);

export type Notification = typeof notification.$inferSelect;

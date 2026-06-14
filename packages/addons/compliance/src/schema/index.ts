import { pgTable, text, real, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const userLimit = pgTable(
  'user_limit',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    // Tenant scope for RLS isolation (ADR-0018). Responsible-gaming / AML data is
    // tenant-confidential, so this table is RLS-enforced like every scoped table.
    tenantId: text('tenantId').notNull().default('default'),
    userId: text('userId').notNull(),
    type: text('type').notNull(),
    amount: real('amount').notNull(),
    period: text('period').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('user_limit_userId_type_period_key').on(t.userId, t.type, t.period),
    index('user_limit_userId_idx').on(t.userId),
    index('user_limit_tenantId_idx').on(t.tenantId),
  ],
);

export const geoRule = pgTable('geo_rule', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  countryCode: text('countryCode').notNull().unique(),
  action: text('action').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
});

export type UserLimit = typeof userLimit.$inferSelect;
export type GeoRule = typeof geoRule.$inferSelect;

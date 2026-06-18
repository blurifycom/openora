import { pgTable, uuid, text, real, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const userLimit = pgTable(
  'user_limit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('userId').notNull(),
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
  ],
);

export const geoRule = pgTable('geo_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  countryCode: text('countryCode').notNull().unique(),
  action: text('action').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
});

export type UserLimit = typeof userLimit.$inferSelect;
export type GeoRule = typeof geoRule.$inferSelect;

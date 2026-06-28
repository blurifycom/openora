import { pgTable, uuid, text, real, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const userLimit = pgTable(
  'user_limit',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    type: text().notNull(),
    amount: real().notNull(),
    period: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('user_limit_user_id_type_period_key').on(t.userId, t.type, t.period),
    index('user_limit_user_id_idx').on(t.userId),
  ],
);

export const geoRule = pgTable('geo_rule', {
  id: uuid().primaryKey().defaultRandom(),
  countryCode: text().notNull().unique('geo_rule_country_code_unique'),
  action: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type UserLimit = typeof userLimit.$inferSelect;
export type GeoRule = typeof geoRule.$inferSelect;

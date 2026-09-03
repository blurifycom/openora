import { pgTable, uuid, text, decimal, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { MONEY_PRECISION, MONEY_SCALE } from '@openora/core/contracts';

/**
 * Generic (base, quote) pair store - not pivot-specific, even though only
 * currency-vs-pivot pairs are currently written.
 */
export const exchangeRateQuote = pgTable(
  'exchange_rate_quote',
  {
    id: uuid().primaryKey().defaultRandom(),
    baseCurrency: text().notNull(),
    quoteCurrency: text().notNull(),
    rate: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    providerAsOf: timestamp({ withTimezone: true }).notNull(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('exchange_rate_quote_base_quote_idx').on(t.baseCurrency, t.quoteCurrency)],
);

export type ExchangeRateQuoteRow = typeof exchangeRateQuote.$inferSelect;
export type ExchangeRateQuoteInsert = typeof exchangeRateQuote.$inferInsert;

import { pgTable, uuid, text, decimal, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { MONEY_PRECISION, MONEY_SCALE } from '@openora/core/contracts';

// Drizzle tables owned by the ExchangeRate module.
// Rules:
//   - Column names come from the key via the snake_case casing config - never pass
//     an explicit string (lint: drizzle-snake-case).
//   - Timestamps are always `withTimezone` (lint: no-naive-timestamp).
//   - Do NOT add FK references to tables owned by another domain - reference by id.

/**
 * Last known good quote per (base, quote) currency pair. The refresh job only ever
 * writes a currency-vs-pivot pair here (see `ExchangeRateConfigSchema.pivot`) - a
 * provider is only expected to quote against one pivot currency - but the table
 * itself is a generic pair store, not pivot-specific, in case a future provider
 * quotes a pair directly. `rate`/`decimal` never `float`: same `numeric(38,18)`
 * shape as a money column (see MONEY_PRECISION/MONEY_SCALE), reused here because a
 * rate needs the same "never lose precision" guarantee a balance does, not because
 * a rate IS money.
 */
export const exchangeRateQuote = pgTable(
  'exchange_rate_quote',
  {
    id: uuid().primaryKey().defaultRandom(),
    baseCurrency: text().notNull(),
    quoteCurrency: text().notNull(),
    rate: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    // The provider's own timestamp for this quote - when the vendor says the rate
    // was true, not when we happened to call it.
    providerAsOf: timestamp({ withTimezone: true }).notNull(),
    // This row's own last-write time, distinct from providerAsOf: lets a caller (or
    // an operator dashboard) tell "the vendor's quote is stale" apart from "we
    // haven't refreshed in a while".
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('exchange_rate_quote_base_quote_idx').on(t.baseCurrency, t.quoteCurrency)],
);

export type ExchangeRateQuoteRow = typeof exchangeRateQuote.$inferSelect;
export type ExchangeRateQuoteInsert = typeof exchangeRateQuote.$inferInsert;

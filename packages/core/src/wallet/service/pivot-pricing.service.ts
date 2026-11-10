import { moneyCompare, moneyScaleBy, sumInPivot } from '@openora/core/server';
import type { ExchangeRateQuote, ExchangeRateReader } from '@openora/core/contracts';

type CurrencyTotal = { currency: string; total: string | null };

/**
 * Per-currency totals summed in the pivot currency; null when a currency with a non-zero total
 * has no rate. A currency whose amounts cancel out needs no rate, so it cannot make the total
 * unknown.
 */
export function pricedInPivot(
  rows: readonly CurrencyTotal[],
  pivotCurrency: string,
  rates: ExchangeRateReader | undefined,
): Promise<string | null> {
  return sumInPivot(
    rows
      .map((row) => ({ currency: row.currency, total: row.total ?? '0' }))
      .filter((row) => moneyCompare(row.total, '0') !== 0),
    pivotCurrency,
    rates,
  );
}

/**
 * `rates` answering each currency pair from the first quote it gave, so one read that prices
 * many players asks for a pair's rate once.
 */
export function withQuoteCache(rates: ExchangeRateReader): ExchangeRateReader {
  const quotes = new Map<string, Promise<ExchangeRateQuote | null>>();
  const getRate = (from: string, to: string) => {
    const key = `${from.toUpperCase()}:${to.toUpperCase()}`;
    const quote = quotes.get(key) ?? rates.getRate(from, to);
    quotes.set(key, quote);
    return quote;
  };
  return {
    getRate,
    convert: async (amount, from, to) => {
      const quote = await getRate(from, to);
      return quote ? moneyScaleBy(amount, quote.rate) : null;
    },
  };
}

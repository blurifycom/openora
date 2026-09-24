import { type ExchangeRateReader } from '@openora/core/contracts';
import { createDomainError, mapConcurrent } from '@openora/core/server';

const GET_RATES_CONCURRENCY = 8;

export const UnsupportedExchangeCurrencyError = createDomainError<[currency: string]>(
  'UnsupportedExchangeCurrencyError',
  (currency) => `Currency is not offered by this operator: ${currency}`,
);

/**
 * The route-facing half of the exchange-rate seam. Every code is checked against the
 * operator's configured currency list first: an unknown code otherwise reaches the reader,
 * misses the cache, and buys a vendor call, so an arbitrary code space would be
 * attacker-controlled vendor spend. A batch answers an unknown source code with a null quote
 * instead of failing the whole batch.
 */
export class ExchangeRateService {
  private readonly supported: ReadonlySet<string>;

  constructor(
    private readonly reader: ExchangeRateReader,
    supportedCurrencies: readonly string[],
  ) {
    this.supported = new Set(supportedCurrencies.map((c) => c.toUpperCase()));
  }

  getRate(from: string, to: string) {
    this.assertSupported(from);
    this.assertSupported(to);
    return this.reader.getRate(from, to);
  }

  getRates(to: string, from: readonly string[]) {
    this.assertSupported(to);
    return mapConcurrent(from, GET_RATES_CONCURRENCY, async (currency) => ({
      from: currency,
      quote: this.isSupported(currency) ? await this.reader.getRate(currency, to) : null,
    }));
  }

  private isSupported(currency: string): boolean {
    return this.supported.has(currency.toUpperCase());
  }

  private assertSupported(currency: string): void {
    if (!this.isSupported(currency)) {
      throw new UnsupportedExchangeCurrencyError(currency);
    }
  }
}

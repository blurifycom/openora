import { type ExchangeRateReader } from '@openora/core/contracts';
import { mapConcurrent } from '@openora/core/server';

// Fan-out is bounded by the contract (`GetExchangeRatesInputSchema.from` caps at
// 50), but every reader call still touches the cache/table, so the fan-out itself
// stays bounded too rather than an unbounded Promise.all.
const GET_RATES_CONCURRENCY = 8;

// Thin router-facing service: the router calls this, this delegates to the module's
// self-bound EXCHANGE_RATE_READER (adapters/exchange-rate-reader.service.ts). Kept
// separate from the reader so a consumer overlay can rebind EXCHANGE_RATE_READER
// without touching this module's own router wiring.
export class ExchangeRateService {
  constructor(private readonly reader: ExchangeRateReader) {}

  getRate(from: string, to: string) {
    return this.reader.getRate(from, to);
  }

  getRates(to: string, from: readonly string[]) {
    return mapConcurrent(from, GET_RATES_CONCURRENCY, async (currency) => ({
      from: currency,
      quote: await this.reader.getRate(currency, to),
    }));
  }
}

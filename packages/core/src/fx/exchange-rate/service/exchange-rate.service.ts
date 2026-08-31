import { type ExchangeRateReader } from '@openora/core/contracts';
import { mapConcurrent } from '@openora/core/server';

const GET_RATES_CONCURRENCY = 8;

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

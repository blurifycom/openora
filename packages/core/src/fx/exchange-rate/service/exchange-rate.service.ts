import { type ExchangeRateReader } from '@openora/core/contracts';

// Thin router-facing service: the router calls this, this delegates to the module's
// self-bound EXCHANGE_RATE_READER (adapters/exchange-rate-reader.service.ts). Kept
// separate from the reader so a consumer overlay can rebind EXCHANGE_RATE_READER
// without touching this module's own router wiring.
export class ExchangeRateService {
  constructor(private readonly reader: ExchangeRateReader) {}

  getRate(from: string, to: string) {
    return this.reader.getRate(from, to);
  }
}

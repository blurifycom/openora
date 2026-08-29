import { createToken, type Token } from './token.js';
import type { ExchangeRateQuote } from './exchange-rate-provider.js';

/**
 * Read side of the exchange-rate seam, for any module that needs a rate without
 * importing the fx module's tables. A player request must NEVER reach a vendor:
 * both methods only ever read the CACHE port, then the fx module's last-known-good
 * table, and return `null` (never throw, never block) when neither has a value. Only
 * the fx module's scheduled refresh job talks to `CRYPTO_EXCHANGE_RATE_PROVIDER` /
 * `FIAT_EXCHANGE_RATE_PROVIDER`.
 *
 * Unlike most ports here, the fx module binds a DB-backed default implementation to
 * this token itself (as with `WALLET_ASSET_CATALOG`/`CACHE`), so an operator gets a
 * working reader with no wiring - and, until a provider is bound and the refresh job
 * has run at least once, a reader that consistently (and correctly) returns `null`.
 */
export type ExchangeRateReader = {
  getRate(from: string, to: string): Promise<ExchangeRateQuote | null>;
  /** `amount * rate(from, to)`, or `null` when no rate is available. */
  convert(amount: string, from: string, to: string): Promise<string | null>;
};

export const EXCHANGE_RATE_READER: Token<ExchangeRateReader> = createToken('EXCHANGE_RATE_READER');

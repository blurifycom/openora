import { createToken, type Token } from './token.js';
import type { ExchangeRateQuote } from './exchange-rate-provider.js';

/**
 * Read side of the exchange-rate seam, for any module that needs a rate without
 * importing the fx module's tables. Read-through cache, not a cache-or-nothing read:
 * a fresh stored quote answers with no vendor call; a soft-stale one answers
 * immediately and refreshes in the background; a hard-stale or missing one is fetched
 * from `CRYPTO_EXCHANGE_RATE_PROVIDER`/`FIAT_EXCHANGE_RATE_PROVIDER` synchronously,
 * with a short timeout, before answering. A player request MAY reach a vendor on that
 * last path - it is bounded and fails closed to `null` (never throws, never blocks
 * past its configured timeout) so a caller like a limit check or a deposit is never
 * left hanging on a vendor.
 *
 * Unlike most ports here, the fx module binds a DB-backed default implementation to
 * this token itself (as with `WALLET_ASSET_CATALOG`/`CACHE`), so an operator gets a
 * working reader with no wiring - and, until a provider is bound and has answered at
 * least once, a reader that consistently (and correctly) returns `null`.
 */
export type ExchangeRateReader = {
  getRate(from: string, to: string): Promise<ExchangeRateQuote | null>;
  /** `amount * rate(from, to)`, or `null` when no rate is available. */
  convert(amount: string, from: string, to: string): Promise<string | null>;
};

export const EXCHANGE_RATE_READER: Token<ExchangeRateReader> = createToken('EXCHANGE_RATE_READER');

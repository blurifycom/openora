import { createToken, type Token } from './token.js';
import type { ExchangeRateQuote } from './exchange-rate-provider.js';

/**
 * Read-through cache: a fresh stored quote answers with no vendor call; a soft-stale one
 * answers immediately and refreshes in the background; a hard-stale or missing one is
 * fetched from `CRYPTO_EXCHANGE_RATE_PROVIDER`/`FIAT_EXCHANGE_RATE_PROVIDER` synchronously,
 * bounded by a timeout, before answering. Fails closed to `null` - never throws, never
 * blocks past its configured timeout.
 *
 * A caller already inside a transaction passes it as `tx`, so the stored quote is read on that
 * connection instead of taking a second one from the pool while the first is held.
 */
export type ExchangeRateReader = {
  getRate(from: string, to: string, tx?: unknown): Promise<ExchangeRateQuote | null>;
  /** `amount * rate(from, to)`, or `null` when no rate is available. */
  convert(amount: string, from: string, to: string, tx?: unknown): Promise<string | null>;
};

export const EXCHANGE_RATE_READER: Token<ExchangeRateReader> = createToken('EXCHANGE_RATE_READER');

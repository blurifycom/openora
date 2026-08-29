import { createToken, type Token } from './token.js';

/**
 * A single vendor quote. `rate` is a decimal string - never a float, so it can be
 * scaled/compared exactly and stored in a Postgres `NUMERIC` column without a
 * round-trip through JS floating point. `asOf` is the ISO timestamp the vendor
 * itself attached to the quote (not "when we called it"), so staleness can be
 * judged from data the vendor is accountable for.
 */
export type ExchangeRateQuote = {
  rate: string;
  asOf: string;
};

/**
 * A vendor's exchange-rate lookup, one currency pair at a time. Providers here are
 * only expected to quote against a single pivot currency (see the fx module's cross
 * pair derivation) - a provider is free to support arbitrary pairs, but nothing in
 * core relies on that. Returns `null` (not a throw) when the vendor has no quote for
 * the pair; a thrown error means the call itself failed (network, auth, ...).
 */
export type ExchangeRateProvider = {
  getRate(from: string, to: string): Promise<ExchangeRateQuote | null>;
};

/**
 * Crypto and fiat rates come from different vendors in practice (a custody/market-data
 * vendor for crypto, an FX-data vendor for fiat), so this is two tokens sharing one
 * shape rather than one token with vendor-specific branching. Both are optional
 * bindings, same as PAYMENT_ADAPTER before an operator configures a vendor: an
 * operator who binds neither still gets a working platform, `EXCHANGE_RATE_READER`
 * just always resolves `null`. Routing between the two uses the wallet module's
 * `railFor` (`@openora/core/contracts`) - never a second classification.
 */
export const CRYPTO_EXCHANGE_RATE_PROVIDER: Token<ExchangeRateProvider> = createToken(
  'CRYPTO_EXCHANGE_RATE_PROVIDER',
);
export const FIAT_EXCHANGE_RATE_PROVIDER: Token<ExchangeRateProvider> = createToken(
  'FIAT_EXCHANGE_RATE_PROVIDER',
);

import { createToken, type Token } from './token.js';

/** `rate` is a decimal string. `asOf` is the ISO timestamp the vendor attached to the quote, not when it was called. */
export type ExchangeRateQuote = {
  rate: string;
  asOf: string;
};

/** Returns `null` when the vendor has no quote for the pair; a thrown error means the call itself failed. */
export type ExchangeRateProvider = {
  getRate(from: string, to: string): Promise<ExchangeRateQuote | null>;
};

/** Both bindings are optional; an operator who binds neither gets `EXCHANGE_RATE_READER` always resolving `null`. */
export const CRYPTO_EXCHANGE_RATE_PROVIDER: Token<ExchangeRateProvider> = createToken(
  'CRYPTO_EXCHANGE_RATE_PROVIDER',
);
export const FIAT_EXCHANGE_RATE_PROVIDER: Token<ExchangeRateProvider> = createToken(
  'FIAT_EXCHANGE_RATE_PROVIDER',
);

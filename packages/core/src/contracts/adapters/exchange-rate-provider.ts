import { createToken, type Token } from './token.js';

export type ExchangeRateQuote = {
  rate: string;
  asOf: string;
};

export type ExchangeRateProvider = {
  getRate(from: string, to: string): Promise<ExchangeRateQuote | null>;
};

export const CRYPTO_EXCHANGE_RATE_PROVIDER: Token<ExchangeRateProvider> = createToken(
  'CRYPTO_EXCHANGE_RATE_PROVIDER',
);
export const FIAT_EXCHANGE_RATE_PROVIDER: Token<ExchangeRateProvider> = createToken(
  'FIAT_EXCHANGE_RATE_PROVIDER',
);

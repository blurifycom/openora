import { createToken, type Token } from './token.js';
import type { ExchangeRateQuote } from './exchange-rate-provider.js';

export type ExchangeRateReader = {
  getRate(from: string, to: string, tx?: unknown): Promise<ExchangeRateQuote | null>;
  convert(amount: string, from: string, to: string, tx?: unknown): Promise<string | null>;
};

export const EXCHANGE_RATE_READER: Token<ExchangeRateReader> = createToken('EXCHANGE_RATE_READER');

import * as z from 'zod';
import { CurrencyTickerInputSchema, CurrencyTickerSchema } from './common.js';

export const DEFAULT_DISPLAY_CRYPTO_CURRENCIES = [
  'BTC',
  'ETH',
  'USDT',
  'USDC',
  'SOL',
  'LTC',
  'DOGE',
  'XRP',
  'TRX',
  'BNB',
  'BCH',
] as const;

export const DEFAULT_DISPLAY_FIAT_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CNY',
  'BRL',
  'RUB',
  'INR',
  'ZAR',
  'EGP',
  'XOF',
] as const;

export const DEFAULT_DISPLAY_CURRENCIES = [
  ...DEFAULT_DISPLAY_CRYPTO_CURRENCIES,
  ...DEFAULT_DISPLAY_FIAT_CURRENCIES,
] as const;

export const DisplayCurrencyCodeSchema = CurrencyTickerSchema;

export const DisplayCurrencyInputSchema = CurrencyTickerInputSchema;

export type DisplayCurrency = z.infer<typeof DisplayCurrencyCodeSchema>;

/**
 * Resolves the operator's supported display-currency list: `platformConfig`
 * override when present and non-empty, else the built-in default. Uppercases and
 * de-duplicates the result.
 */
export function resolveDisplayCurrencies(overrides?: readonly string[]): string[] {
  const source = overrides && overrides.length > 0 ? overrides : DEFAULT_DISPLAY_CURRENCIES;
  return [...new Set(source.map((c) => c.toUpperCase()))];
}

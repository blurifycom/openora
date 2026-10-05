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

// The platform stores every amount at 18 decimal places, so a display precision past that
// would only pad zeros that carry no value.
export const MAX_DISPLAY_DECIMAL_PLACES = 18;

// How many decimals a player wants amounts rendered with. Presentation only: it never rounds
// a stored or submitted amount. `null` means no pick, so the client uses the currency default.
export const DisplayDecimalPlacesSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_DISPLAY_DECIMAL_PLACES)
  .nullable();

/**
 * Resolves the operator's supported display-currency list: `platformConfig`
 * override when present and non-empty, else the built-in default. Uppercases and
 * de-duplicates the result.
 */
export function resolveDisplayCurrencies(overrides?: readonly string[]): string[] {
  const source = overrides && overrides.length > 0 ? overrides : DEFAULT_DISPLAY_CURRENCIES;
  return [...new Set(source.map((c) => c.toUpperCase()))];
}

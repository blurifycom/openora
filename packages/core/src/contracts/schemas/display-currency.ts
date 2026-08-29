import * as z from 'zod';
import { CurrencyTickerInputSchema, CurrencyTickerSchema } from './common.js';

// Canonical, operator-overridable list of currencies a player may pick to have the
// UI RENDER amounts in. Display is presentation-only: picking one never changes a
// balance, a ledger row, or a transaction amount - see the fx module's
// EXCHANGE_RATE_READER for the read side and pam/profile for where the pick is
// stored (`player.displayCurrency`).
//
// Distinct from two other currency lists that already exist:
//   - `DEFAULT_CRYPTO_CURRENCIES` (wallet-tx.ts) classifies a currency onto the
//     crypto/fiat SETTLEMENT rail; it says nothing about what a player may pick to
//     look at.
//   - `IgamingConfig.currencies` is the set the platform actually transacts
//     (holds balances / settles) in.
// A display currency needs neither: a player can look at their balance in a
// currency the operator never settles in.
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

// A display currency is a distinct concept from a wallet/settlement currency, but
// it accepts the same ticker shape - both alias the neutral-zone schema so the two
// can never drift apart.
export const DisplayCurrencyCodeSchema = CurrencyTickerSchema;

// Codes are canonically uppercase - normalize player input on the way in so a
// lowercase request can never diverge from the stored/compared value.
export const DisplayCurrencyInputSchema = CurrencyTickerInputSchema;

export type DisplayCurrency = z.infer<typeof DisplayCurrencyCodeSchema>;

/**
 * Resolves the operator's supported display-currency list: `platformConfig`
 * override when present and non-empty, else the built-in default. Uppercased and
 * de-duplicated so a lowercase or duplicate operator entry can't produce a
 * mismatched compare against a stored (always-uppercase) `player.displayCurrency`.
 */
export function resolveDisplayCurrencies(overrides?: readonly string[]): string[] {
  const source = overrides && overrides.length > 0 ? overrides : DEFAULT_DISPLAY_CURRENCIES;
  return [...new Set(source.map((c) => c.toUpperCase()))];
}

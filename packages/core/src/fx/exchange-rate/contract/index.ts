import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyCodeSchema,
  DisplayCurrencyCodeSchema,
  MoneyAmountSchema,
  TimestampSchema,
} from '@openora/core/contracts';

// Canonical request/response shapes for the ExchangeRate module. This is the
// single source of truth - the router validates against it, live OpenAPI + the typed
// client are emitted from it. Derive related shapes with .pick()/.omit()/.extend()
// rather than re-typing fields. Promote anything shared across domains to
// @openora/core/contracts. This dir is isomorphic: Zod + @openora/core/contracts only.

// `rate` reuses MoneyAmountSchema's decimal-string shape (non-negative, no float) -
// a rate needs the same exactness a money amount does, even though it isn't money.
export const ExchangeRateQuoteSchema = z.object({
  rate: MoneyAmountSchema,
  asOf: TimestampSchema,
});
export type ExchangeRateQuoteDto = z.infer<typeof ExchangeRateQuoteSchema>;

export const GetExchangeRateInputSchema = z.object({
  from: CurrencyCodeSchema,
  to: CurrencyCodeSchema,
});
export type GetExchangeRateInput = z.infer<typeof GetExchangeRateInputSchema>;

// Batched form of `getRate`: one target currency, several source currencies, so a
// header rendering multiple balances at once issues one call instead of fanning
// out a request per currency. Uses `DisplayCurrencyCodeSchema` (not the stricter
// 3-letter `CurrencyCodeSchema`) because a source currency here is typically a
// wallet balance's currency, which may be a longer crypto ticker (USDT, USDC).
export const GetExchangeRatesInputSchema = z.object({
  to: DisplayCurrencyCodeSchema,
  from: z.array(DisplayCurrencyCodeSchema).min(1).max(50),
});
export type GetExchangeRatesInput = z.infer<typeof GetExchangeRatesInputSchema>;

export const ExchangeRateBatchEntrySchema = z.object({
  from: DisplayCurrencyCodeSchema,
  // `null` for a pair with no rate available - a missing rate for one currency
  // never fails the whole batch, same contract as the singular `getRate`.
  quote: ExchangeRateQuoteSchema.nullable(),
});
export type ExchangeRateBatchEntry = z.infer<typeof ExchangeRateBatchEntrySchema>;

export const exchangeRateContract = {
  // Read-only, cache/table-backed - never calls a vendor. Returns `null` when no
  // rate is available yet (nothing stored, or the pair can't be derived from what
  // is stored). See the fx module's ExchangeRateReaderService.
  getRate: oc
    .route({ method: 'GET', path: '/exchange-rate/rate' })
    .input(GetExchangeRateInputSchema)
    .output(ExchangeRateQuoteSchema.nullable()),

  getRates: oc
    .route({ method: 'GET', path: '/exchange-rate/rates' })
    .input(GetExchangeRatesInputSchema)
    .output(z.array(ExchangeRateBatchEntrySchema)),
};

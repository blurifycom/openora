import { oc } from '@orpc/contract';
import * as z from 'zod';
import { CurrencyCodeSchema, MoneyAmountSchema, TimestampSchema } from '@openora/core/contracts';

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

export const exchangeRateContract = {
  // Read-only, cache/table-backed - never calls a vendor. Returns `null` when no
  // rate is available yet (nothing stored, or the pair can't be derived from what
  // is stored). See the fx module's ExchangeRateReaderService.
  getRate: oc
    .route({ method: 'GET', path: '/exchange-rate/rate' })
    .input(GetExchangeRateInputSchema)
    .output(ExchangeRateQuoteSchema.nullable()),
};

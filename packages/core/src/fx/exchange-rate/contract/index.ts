import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyCodeSchema,
  DisplayCurrencyCodeSchema,
  MoneyAmountSchema,
  TimestampSchema,
} from '@openora/core/contracts';

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

export const GetExchangeRatesInputSchema = z.object({
  to: DisplayCurrencyCodeSchema,
  from: z.array(DisplayCurrencyCodeSchema).min(1).max(50),
});
export type GetExchangeRatesInput = z.infer<typeof GetExchangeRatesInputSchema>;

export const ExchangeRateBatchEntrySchema = z.object({
  from: DisplayCurrencyCodeSchema,
  quote: ExchangeRateQuoteSchema.nullable(),
});
export type ExchangeRateBatchEntry = z.infer<typeof ExchangeRateBatchEntrySchema>;

export const exchangeRateContract = {
  getRate: oc
    .route({ method: 'GET', path: '/exchange-rate/rate' })
    .input(GetExchangeRateInputSchema)
    .output(ExchangeRateQuoteSchema.nullable()),

  getRates: oc
    .route({ method: 'GET', path: '/exchange-rate/rates' })
    .input(GetExchangeRatesInputSchema)
    .output(z.array(ExchangeRateBatchEntrySchema)),
};

import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyCodeSchema,
  DateRangeSchema,
  GranularitySchema,
  MoneyAmountSchema,
  SignedMoneyAmountSchema,
  WalletRailSchema,
} from '@openora/core/contracts';

export { SignedMoneyAmountSchema, type SignedMoneyAmount } from '@openora/core/contracts';

export const MoneyByCurrencyRailSchema = z.object({
  currency: CurrencyCodeSchema,
  rail: WalletRailSchema.nullable(),
  total: MoneyAmountSchema,
});
export type MoneyByCurrencyRail = z.infer<typeof MoneyByCurrencyRailSchema>;

export const MoneyByCurrencySchema = z.object({
  currency: CurrencyCodeSchema,
  total: SignedMoneyAmountSchema,
});
export type MoneyByCurrency = z.infer<typeof MoneyByCurrencySchema>;

export const FinancialSummarySchema = z.object({
  deposits: z.array(MoneyByCurrencyRailSchema),
  withdrawals: z.array(MoneyByCurrencyRailSchema),
  netRevenue: z.array(MoneyByCurrencySchema),
  bonusCost: z.array(MoneyByCurrencySchema),
});
export type FinancialSummary = z.infer<typeof FinancialSummarySchema>;

export const FinancialSummaryQuerySchema = DateRangeSchema.extend({
  currency: CurrencyCodeSchema.optional(),
});
export type FinancialSummaryQuery = z.infer<typeof FinancialSummaryQuerySchema>;

export const GgrPointSchema = z.object({
  bucket: z.string(),
  ggr: SignedMoneyAmountSchema,
});

export const GgrSeriesSchema = z.object({
  currency: CurrencyCodeSchema,
  points: z.array(GgrPointSchema),
});
export type GgrSeries = z.infer<typeof GgrSeriesSchema>;

export const FinancialGgrQuerySchema = DateRangeSchema.extend({
  currency: CurrencyCodeSchema.optional(),
  granularity: GranularitySchema.default('day'),
});
export type FinancialGgrQuery = z.infer<typeof FinancialGgrQuerySchema>;

export const financialContract = {
  summary: oc
    .route({ method: 'GET', path: '/analytics/financial/summary' })
    .input(FinancialSummaryQuerySchema)
    .output(FinancialSummarySchema),

  ggr: oc
    .route({ method: 'GET', path: '/analytics/financial/ggr' })
    .input(FinancialGgrQuerySchema)
    .output(z.array(GgrSeriesSchema)),
};

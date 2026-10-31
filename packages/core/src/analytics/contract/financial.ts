import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyTickerInputSchema,
  CurrencyTickerSchema,
  DateRangeSchema,
  GameTypeSchema,
  GranularitySchema,
  MoneyAmountSchema,
  SignedMoneyAmountSchema,
  WalletRailSchema,
} from '@openora/core/contracts';

export { SignedMoneyAmountSchema, type SignedMoneyAmount } from '@openora/core/contracts';

export const MoneyByCurrencyRailSchema = z.object({
  currency: CurrencyTickerSchema,
  rail: WalletRailSchema.nullable(),
  total: MoneyAmountSchema,
});
export type MoneyByCurrencyRail = z.infer<typeof MoneyByCurrencyRailSchema>;

export const MoneyByCurrencySchema = z.object({
  currency: CurrencyTickerSchema,
  total: SignedMoneyAmountSchema,
});
export type MoneyByCurrency = z.infer<typeof MoneyByCurrencySchema>;

export const FinancialSummarySchema = z.object({
  deposits: z.array(MoneyByCurrencyRailSchema),
  withdrawals: z.array(MoneyByCurrencyRailSchema),
  netDeposits: z.array(MoneyByCurrencySchema),
  ggr: z.array(MoneyByCurrencySchema),
  bonusCost: z.array(MoneyByCurrencySchema),
  ngr: z.array(MoneyByCurrencySchema),
});
export type FinancialSummary = z.infer<typeof FinancialSummarySchema>;

export const FinancialSummaryQuerySchema = DateRangeSchema.extend({
  currency: CurrencyTickerInputSchema.optional(),
});
export type FinancialSummaryQuery = z.infer<typeof FinancialSummaryQuerySchema>;

export const GgrPointSchema = z.object({
  bucket: z.string(),
  ggr: SignedMoneyAmountSchema,
});

export const GgrSeriesSchema = z.object({
  currency: CurrencyTickerSchema,
  points: z.array(GgrPointSchema),
});
export type GgrSeries = z.infer<typeof GgrSeriesSchema>;

export const FinancialGgrQuerySchema = DateRangeSchema.extend({
  currency: CurrencyTickerInputSchema.optional(),
  granularity: GranularitySchema.default('day'),
});
export type FinancialGgrQuery = z.infer<typeof FinancialGgrQuerySchema>;

/**
 * Stakes and payouts per product. A sportsbook stake counts when the bet is accepted and only its
 * cash part; a payout counts when the bet settles, and a reopen takes it back in the reopen's period.
 */
export const ProductRevenueSchema = z.object({
  product: GameTypeSchema,
  currency: CurrencyTickerSchema,
  stakes: MoneyAmountSchema,
  payouts: SignedMoneyAmountSchema,
  ggr: SignedMoneyAmountSchema,
});
export type ProductRevenue = z.infer<typeof ProductRevenueSchema>;

export const financialContract = {
  summary: oc
    .route({ method: 'GET', path: '/analytics/financial/summary' })
    .input(FinancialSummaryQuerySchema)
    .output(FinancialSummarySchema),

  ggr: oc
    .route({ method: 'GET', path: '/analytics/financial/ggr' })
    .input(FinancialGgrQuerySchema)
    .output(z.array(GgrSeriesSchema)),

  products: oc
    .route({ method: 'GET', path: '/analytics/financial/products' })
    .input(FinancialSummaryQuerySchema)
    .output(z.array(ProductRevenueSchema)),
};

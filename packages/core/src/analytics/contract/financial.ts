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
  /** The official GGR: wallet stakes less voided stakes less wins plus reversed wins, cash basis. */
  ggr: z.array(MoneyByCurrencySchema),
  bonusCost: z.array(MoneyByCurrencySchema),
  /**
   * What sportsbook promotions paid less what reopens took back in the range, already inside `ggr`.
   * A reopen takes back its whole promotion part even when the wallet could not collect it, so
   * this can be lower than `ggr`'s promotion share by that uncollected debt. Empty without the
   * sportsbook module.
   */
  sportsbookPromotionCost: z.array(MoneyByCurrencySchema),
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
 * Stakes and payouts per product, on a settled basis, not the official GGR. A sportsbook stake
 * counts when the bet is accepted and only its cash part; a payout counts when the bet settles, and
 * a reopen takes it back in the reopen's period.
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
    .route({
      method: 'GET',
      path: '/analytics/financial/summary',
      summary: 'Financial summary with the official GGR, cash basis',
    })
    .input(FinancialSummaryQuerySchema)
    .output(FinancialSummarySchema),

  ggr: oc
    .route({
      method: 'GET',
      path: '/analytics/financial/ggr',
      summary: 'Official GGR trend, cash basis',
    })
    .input(FinancialGgrQuerySchema)
    .output(z.array(GgrSeriesSchema)),

  products: oc
    .route({
      method: 'GET',
      path: '/analytics/financial/products',
      summary: 'Revenue by product, settled basis',
    })
    .input(FinancialSummaryQuerySchema)
    .output(z.array(ProductRevenueSchema)),
};

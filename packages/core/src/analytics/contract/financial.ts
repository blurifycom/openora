import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  FinancialGgrQuerySchema,
  FinancialSummaryQuerySchema,
  FinancialSummarySchema,
  GgrSeriesSchema,
  ProductRevenueSchema,
} from '@openora/core/contracts';

// The shapes live beside MONEY_REPORTING, the port the wallet answers them through.
export {
  SignedMoneyAmountSchema,
  type SignedMoneyAmount,
  MoneyByCurrencyRailSchema,
  type MoneyByCurrencyRail,
  MoneyByCurrencySchema,
  type MoneyByCurrency,
  FinancialSummarySchema,
  type FinancialSummary,
  FinancialSummaryQuerySchema,
  type FinancialSummaryQuery,
  GgrPointSchema,
  GgrSeriesSchema,
  type GgrSeries,
  FinancialGgrQuerySchema,
  type FinancialGgrQuery,
  UNCLASSIFIED_PRODUCT,
  ProductRevenueSchema,
  type ProductRevenue,
} from '@openora/core/contracts';

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

import type { CacheAdapter, MoneyReportingPort, PaymentsFlowQuery } from '@openora/core/contracts';
import { moneyAdd } from '@openora/core/server';
import {
  FINANCIAL_SUMMARY_MAX_CURRENCIES,
  FINANCIAL_SUMMARY_MAX_PRODUCT_ROWS,
  PAYMENTS_FLOW_MAX_ROWS,
  PAYMENT_FLOW_TYPES,
  resolveFinancialSummaryRange,
  resolveGgrSummaryRange,
  resolvePaymentsFlowRange,
  type FinancialCurrencyTotals,
  type FinancialSummaryInput,
  type FinancialSummaryOverview,
  type MoneyByCurrency,
  type MoneyByCurrencyRail,
  type PaymentsFlow,
  type PaymentsFlowInput,
  type ProductRevenue,
  type FinancialGgrQuery,
  type FinancialSummary,
  type FinancialSummaryQuery,
  type GgrSeries,
  type GgrSummaryInput,
} from '../contract/index.js';

const ANALYTICS_CACHE_TTL_MS = 60_000;

function sumByCurrency(rows: readonly MoneyByCurrencyRail[]): Map<string, string> {
  const sums = new Map<string, string>();
  for (const row of rows) {
    sums.set(row.currency, moneyAdd(sums.get(row.currency) ?? '0', row.total));
  }
  return sums;
}

function byCurrency(rows: readonly MoneyByCurrency[]): Map<string, string> {
  return new Map(rows.map((row) => [row.currency, row.total]));
}

/** One row per currency of a financial summary, rails folded together. */
export function totalsPerCurrency(summary: FinancialSummary): FinancialCurrencyTotals[] {
  const deposits = sumByCurrency(summary.deposits);
  const withdrawals = sumByCurrency(summary.withdrawals);
  const netDeposits = byCurrency(summary.netDeposits);
  const ggr = byCurrency(summary.ggr);
  const bonusCost = byCurrency(summary.bonusCost);
  const ngr = byCurrency(summary.ngr);
  const currencies = new Set([...deposits.keys(), ...withdrawals.keys(), ...ggr.keys()]);
  return [...currencies].sort().map((currency) => ({
    currency,
    deposits: deposits.get(currency) ?? '0',
    withdrawals: withdrawals.get(currency) ?? '0',
    netDeposits: netDeposits.get(currency) ?? '0',
    ggr: ggr.get(currency) ?? '0',
    bonusCost: bonusCost.get(currency) ?? '0',
    ngr: ngr.get(currency) ?? '0',
  }));
}

export class FinancialAnalyticsService {
  // The queries are the money side's (MONEY_REPORTING); this caches and shapes them.
  constructor(
    private readonly reporting: MoneyReportingPort,
    private readonly cache: CacheAdapter,
  ) {}

  async summary(query: FinancialSummaryQuery): Promise<FinancialSummary> {
    return this.cached('financial.summary.v2', query, () => this.reporting.summary(query));
  }

  async ggr(query: FinancialGgrQuery): Promise<GgrSeries[]> {
    return this.cached('financial.ggr', query, () => this.reporting.ggr(query));
  }

  async products(query: FinancialSummaryQuery): Promise<ProductRevenue[]> {
    return this.cached('financial.products', query, () => this.reporting.products(query));
  }

  async ggrSummary({ currency, granularity, ...dates }: GgrSummaryInput, now = new Date()) {
    const range = resolveGgrSummaryRange(dates, now);
    const series = await this.ggr({
      dateFrom: `${range.dateFrom}T00:00:00.000Z`,
      dateTo: `${range.dateTo}T23:59:59.999Z`,
      currency: currency?.toUpperCase(),
      granularity,
    });
    return { ...range, granularity, series };
  }

  async financialSummary(
    { currency, ...dates }: FinancialSummaryInput,
    now = new Date(),
  ): Promise<FinancialSummaryOverview> {
    const range = resolveFinancialSummaryRange(dates, now);
    const query = {
      dateFrom: `${range.dateFrom}T00:00:00.000Z`,
      dateTo: `${range.dateTo}T23:59:59.999Z`,
      currency: currency?.toUpperCase(),
    };
    const [summary, products] = await Promise.all([this.summary(query), this.products(query)]);
    const currencies = totalsPerCurrency(summary);
    return {
      ...range,
      currencies: currencies.slice(0, FINANCIAL_SUMMARY_MAX_CURRENCIES),
      products: products.slice(0, FINANCIAL_SUMMARY_MAX_PRODUCT_ROWS),
      truncated:
        currencies.length > FINANCIAL_SUMMARY_MAX_CURRENCIES ||
        products.length > FINANCIAL_SUMMARY_MAX_PRODUCT_ROWS,
    };
  }

  /**
   * Deposits and withdrawals per bucket, type, status and currency, over whole UTC days. A row
   * holds the transactions created in its bucket under the status they hold now.
   */
  async paymentsFlow(
    { dateFrom, dateTo, types, statuses, currency, granularity }: PaymentsFlowInput,
    now = new Date(),
  ): Promise<PaymentsFlow> {
    const range = resolvePaymentsFlowRange({ dateFrom, dateTo }, now);
    const query: PaymentsFlowQuery = {
      ...range,
      granularity,
      types: types ?? PAYMENT_FLOW_TYPES,
      statuses: statuses ?? null,
      currency: currency?.toUpperCase() ?? null,
    };
    const rows = await this.cached('payments.flow', query, () =>
      this.reporting.paymentsFlow(query),
    );
    return {
      ...range,
      granularity,
      rows: rows.slice(0, PAYMENTS_FLOW_MAX_ROWS),
      truncated: rows.length > PAYMENTS_FLOW_MAX_ROWS,
    };
  }

  private async cached<T>(scope: string, query: object, compute: () => Promise<T>): Promise<T> {
    const key = `analytics:${scope}:${JSON.stringify(query, Object.keys(query).sort())}`;
    const cached = await this.cache.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await compute();
    await this.cache.set(key, value, { ttlMs: ANALYTICS_CACHE_TTL_MS });
    return value;
  }
}

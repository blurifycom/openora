import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { CacheAdapter, Granularity } from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { walletTransaction } from '@openora/core/wallet/schema';
import type {
  FinancialGgrQuery,
  FinancialSummary,
  FinancialSummaryQuery,
  GgrSeries,
} from '../contract/index.js';

const ANALYTICS_CACHE_TTL_MS = 60_000;
const DEFAULT_GGR_RANGE_DAYS = 30;
const COMPLETED_STATUS = 'completed';

const GRANULARITY_INTERVALS: Record<Granularity, string> = {
  day: '1 day',
  week: '1 week',
  month: '1 month',
};

function toBucketKey(bucket: Date | string): string {
  return new Date(bucket).toISOString().slice(0, 10);
}

function resolveGgrRange(dateFrom?: string, dateTo?: string): { from: Date; to: Date } {
  const to = dateTo ? new Date(dateTo) : new Date();
  const from = dateFrom
    ? new Date(dateFrom)
    : new Date(to.getTime() - DEFAULT_GGR_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

function dateRangeConditions(dateFrom?: string, dateTo?: string) {
  const conditions = [];
  if (dateFrom) {
    conditions.push(gte(walletTransaction.createdAt, new Date(dateFrom)));
  }
  if (dateTo) {
    conditions.push(lte(walletTransaction.createdAt, new Date(dateTo)));
  }
  return conditions;
}

export class FinancialAnalyticsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly cache: CacheAdapter,
  ) {}

  async summary(query: FinancialSummaryQuery): Promise<FinancialSummary> {
    return this.cached('financial.summary', query, () => this.computeSummary(query));
  }

  async ggr(query: FinancialGgrQuery): Promise<GgrSeries[]> {
    return this.cached('financial.ggr', query, () => this.computeGgr(query));
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

  private async computeSummary({
    dateFrom,
    dateTo,
    currency,
  }: FinancialSummaryQuery): Promise<FinancialSummary> {
    const db = this.drizzle.db;
    const baseConditions = dateRangeConditions(dateFrom, dateTo);
    if (currency) {
      baseConditions.push(eq(walletTransaction.currency, currency));
    }

    const [byRail, byCurrency] = await Promise.all([
      db
        .select({
          currency: walletTransaction.currency,
          rail: walletTransaction.rail,
          type: walletTransaction.type,
          total: sql<string>`sum(${walletTransaction.amount})`,
        })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.status, COMPLETED_STATUS),
            inArray(walletTransaction.type, ['deposit', 'withdrawal']),
            ...baseConditions,
          ),
        )
        .groupBy(walletTransaction.currency, walletTransaction.rail, walletTransaction.type),
      db
        .select({
          currency: walletTransaction.currency,
          netRevenue: sql<string>`
            coalesce(sum(${walletTransaction.amount}) filter (where ${walletTransaction.type} = 'deposit'), 0)
            - coalesce(sum(${walletTransaction.amount}) filter (where ${walletTransaction.type} = 'withdrawal'), 0)
            - coalesce(sum(${walletTransaction.amount}) filter (where ${walletTransaction.type} = 'bonus'), 0)
          `,
          bonusCost: sql<string>`coalesce(sum(${walletTransaction.amount}) filter (where ${walletTransaction.type} = 'bonus'), 0)`,
        })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.status, COMPLETED_STATUS),
            inArray(walletTransaction.type, ['deposit', 'withdrawal', 'bonus']),
            ...baseConditions,
          ),
        )
        .groupBy(walletTransaction.currency),
    ]);

    return {
      deposits: byRail
        .filter((r) => r.type === 'deposit')
        .map((r) => ({ currency: r.currency, rail: r.rail, total: r.total })),
      withdrawals: byRail
        .filter((r) => r.type === 'withdrawal')
        .map((r) => ({ currency: r.currency, rail: r.rail, total: r.total })),
      netRevenue: byCurrency.map((r) => ({ currency: r.currency, total: r.netRevenue })),
      bonusCost: byCurrency.map((r) => ({ currency: r.currency, total: r.bonusCost })),
    };
  }

  private async computeGgr({
    dateFrom,
    dateTo,
    currency,
    granularity,
  }: FinancialGgrQuery): Promise<GgrSeries[]> {
    const range = resolveGgrRange(dateFrom, dateTo);
    const interval = GRANULARITY_INTERVALS[granularity];
    const currencyFilter = currency ? sql`and currency = ${currency}` : sql``;
    const forceCurrency = currency ? sql`union select ${currency}::text` : sql``;

    const result = await this.drizzle.db.execute<{
      currency: string;
      bucket: Date | string;
      ggr: string;
    }>(sql`
      with range as (
        select generate_series(
          date_trunc(${granularity}, ${range.from}::timestamptz),
          date_trunc(${granularity}, ${range.to}::timestamptz),
          ${interval}::interval
        ) as bucket
      ),
      currencies as (
        select distinct currency
        from ${walletTransaction}
        where status = ${COMPLETED_STATUS}
          and type in ('bet', 'win')
          and created_at between ${range.from} and ${range.to}
          ${currencyFilter}
        ${forceCurrency}
      ),
      buckets as (
        select c.currency, r.bucket from currencies c cross join range r
      ),
      agg as (
        select
          currency,
          date_trunc(${granularity}, created_at) as bucket,
          coalesce(sum(amount) filter (where type = 'bet'), 0)
            - coalesce(sum(amount) filter (where type = 'win'), 0) as ggr
        from ${walletTransaction}
        where status = ${COMPLETED_STATUS}
          and type in ('bet', 'win')
          and created_at between ${range.from} and ${range.to}
          ${currencyFilter}
        group by 1, 2
      )
      select b.currency, b.bucket, coalesce(agg.ggr, 0) as ggr
      from buckets b
      left join agg on agg.currency = b.currency and agg.bucket = b.bucket
      order by b.currency, b.bucket
    `);

    const seriesByCurrency = new Map<string, GgrSeries>();
    for (const row of result.rows) {
      const series = seriesByCurrency.get(row.currency) ?? { currency: row.currency, points: [] };
      series.points.push({ bucket: toBucketKey(row.bucket), ggr: row.ggr });
      seriesByCurrency.set(row.currency, series);
    }
    return Array.from(seriesByCurrency.values());
  }
}

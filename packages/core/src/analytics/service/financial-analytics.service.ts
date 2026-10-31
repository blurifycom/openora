import { and, eq, gte, inArray, isNotNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import type { CacheAdapter, GameType, Granularity } from '@openora/core/contracts';
import { DrizzleService, moneyAdd, moneySubtract } from '@openora/core/server';
import { game, gameRound } from '@openora/core/casino/schema/gaming';
import { sportsbookBet, sportsbookBetTransaction } from '@openora/core/sportsbook/schema/betting';
import { walletTransaction } from '@openora/core/wallet/schema';
import {
  resolveGgrSummaryRange,
  type ProductRevenue,
  type FinancialGgrQuery,
  type FinancialSummary,
  type FinancialSummaryQuery,
  type GgrSeries,
  type GgrSummaryInput,
} from '../contract/index.js';

const ANALYTICS_CACHE_TTL_MS = 60_000;
const DEFAULT_GGR_RANGE_DAYS = 30;
const COMPLETED_STATUS = 'completed';
const GGR_TYPES = ['bet', 'bet_reversal', 'win', 'win_reversal'] as const;
const SUMMARY_TYPES = ['deposit', 'withdrawal', 'bonus', ...GGR_TYPES] as const;

const sumOf = (type: (typeof SUMMARY_TYPES)[number]) =>
  sql`coalesce(sum(${walletTransaction.amount}) filter (where ${walletTransaction.type} = ${type}), 0)`;
const GGR = sql`${sumOf('bet')} - ${sumOf('bet_reversal')} - ${sumOf('win')} + ${sumOf('win_reversal')}`;

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

function inRange(
  at: PgColumn,
  currencyColumn: PgColumn,
  { dateFrom, dateTo, currency }: FinancialSummaryQuery,
) {
  return [
    ...(dateFrom ? [gte(at, new Date(dateFrom))] : []),
    ...(dateTo ? [lte(at, new Date(dateTo))] : []),
    ...(currency ? [eq(currencyColumn, currency)] : []),
  ];
}

const total = (column: PgColumn | SQL) => sql<string>`coalesce(sum(${column}), 0)`;

export class FinancialAnalyticsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly cache: CacheAdapter,
    private readonly sportsbook = false,
  ) {}

  async summary(query: FinancialSummaryQuery): Promise<FinancialSummary> {
    return this.cached('financial.summary', query, () => this.computeSummary(query));
  }

  async ggr(query: FinancialGgrQuery): Promise<GgrSeries[]> {
    return this.cached('financial.ggr', query, () => this.computeGgr(query));
  }

  async products(query: FinancialSummaryQuery): Promise<ProductRevenue[]> {
    return this.cached('financial.products', query, () => this.computeProducts(query));
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

    const totalsByRail = (type: 'deposit' | 'withdrawal') =>
      db
        .select({
          currency: walletTransaction.currency,
          rail: walletTransaction.rail,
          total: sql<string>`sum(${walletTransaction.amount})`,
        })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.status, COMPLETED_STATUS),
            eq(walletTransaction.type, type),
            ...baseConditions,
          ),
        )
        .groupBy(walletTransaction.currency, walletTransaction.rail);

    const [deposits, withdrawals, byCurrency] = await Promise.all([
      totalsByRail('deposit'),
      totalsByRail('withdrawal'),
      db
        .select({
          currency: walletTransaction.currency,
          netDeposits: sql<string>`
            ${sumOf('deposit')} - ${sumOf('withdrawal')} - ${sumOf('bonus')}
          `,
          ggr: sql<string>`${GGR}`,
          bonusCost: sql<string>`${sumOf('bonus')}`,
          ngr: sql<string>`${GGR} - ${sumOf('bonus')}`,
        })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.status, COMPLETED_STATUS),
            inArray(walletTransaction.type, SUMMARY_TYPES),
            ...baseConditions,
          ),
        )
        .groupBy(walletTransaction.currency),
    ]);

    return {
      deposits,
      withdrawals,
      netDeposits: byCurrency.map((r) => ({ currency: r.currency, total: r.netDeposits })),
      ggr: byCurrency.map((r) => ({ currency: r.currency, total: r.ggr })),
      bonusCost: byCurrency.map((r) => ({ currency: r.currency, total: r.bonusCost })),
      ngr: byCurrency.map((r) => ({ currency: r.currency, total: r.ngr })),
    };
  }

  private async computeProducts(query: FinancialSummaryQuery): Promise<ProductRevenue[]> {
    const db = this.drizzle.db;
    const bet = sportsbookBet;
    const tx = sportsbookBetTransaction;
    const prior = alias(sportsbookBetTransaction, 'prior_settle');
    const book = <T>(query: () => Promise<T[]>) => (this.sportsbook ? query() : []);
    const [rounds, bookStakes, bookPayouts, bookReversals] = await Promise.all([
      db
        .select({
          product: game.gameType,
          currency: gameRound.currency,
          stakes: total(gameRound.betAmount),
          payouts: total(gameRound.winAmount),
        })
        .from(gameRound)
        .innerJoin(game, eq(game.id, gameRound.gameId))
        .where(
          and(
            eq(gameRound.status, COMPLETED_STATUS),
            // With the book loaded its ledger is the sportsbook row, not a catalog game typed so.
            ...(this.sportsbook ? [ne(game.gameType, 'sportsbook')] : []),
            ...inRange(gameRound.startedAt, gameRound.currency, query),
          ),
        )
        .groupBy(game.gameType, gameRound.currency),
      book(() =>
        db
          .select({ currency: bet.currency, amount: total(bet.cashStake) })
          .from(bet)
          .where(and(isNotNull(bet.acceptedAt), ...inRange(bet.acceptedAt, bet.currency, query)))
          .groupBy(bet.currency),
      ),
      book(() =>
        db
          .select({ currency: bet.currency, amount: total(tx.amount) })
          .from(tx)
          .innerJoin(bet, eq(bet.id, tx.betId))
          .where(and(eq(tx.kind, 'settle'), ...inRange(tx.createdAt, bet.currency, query)))
          .groupBy(bet.currency),
      ),
      // A reopen takes back the whole payout of the settlement it reopens, whatever it collected.
      book(() =>
        db
          .select({ currency: bet.currency, amount: total(prior.amount) })
          .from(tx)
          .innerJoin(bet, eq(bet.id, tx.betId))
          .innerJoin(
            prior,
            and(
              eq(prior.betId, tx.betId),
              eq(prior.kind, 'settle'),
              eq(prior.betVersion, sql`${tx.betVersion} - 1`),
            ),
          )
          .where(and(eq(tx.kind, 'reopen'), ...inRange(tx.createdAt, bet.currency, query)))
          .groupBy(bet.currency),
      ),
    ]);

    const rows = new Map<string, ProductRevenue>();
    const add = (product: GameType, currency: string, stakes: string, payouts: string) => {
      const key = `${product}:${currency}`;
      const row = rows.get(key) ?? { product, currency, stakes: '0', payouts: '0', ggr: '0' };
      row.stakes = moneyAdd(row.stakes, stakes);
      row.payouts = moneyAdd(row.payouts, payouts);
      row.ggr = moneySubtract(row.stakes, row.payouts);
      rows.set(key, row);
    };
    for (const r of rounds) {
      add(r.product, r.currency, r.stakes, r.payouts);
    }
    for (const r of bookStakes) {
      add('sportsbook', r.currency, r.amount, '0');
    }
    for (const r of bookPayouts) {
      add('sportsbook', r.currency, '0', r.amount);
    }
    for (const r of bookReversals) {
      add('sportsbook', r.currency, '0', moneySubtract('0', r.amount));
    }
    return [...rows.values()].sort(
      (a, b) => a.product.localeCompare(b.product) || a.currency.localeCompare(b.currency),
    );
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
          and ${inArray(walletTransaction.type, GGR_TYPES)}
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
          ${GGR} as ggr
        from ${walletTransaction}
        where status = ${COMPLETED_STATUS}
          and ${inArray(walletTransaction.type, GGR_TYPES)}
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

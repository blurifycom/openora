import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import {
  PAYMENTS_FLOW_MAX_ROWS,
  UNCLASSIFIED_PRODUCT,
  type FinancialGgrQuery,
  type FinancialSummary,
  type FinancialSummaryQuery,
  type GgrSeries,
  type Granularity,
  type MoneyFunnelActivity,
  type MoneyReportingPort,
  type PaymentFlowRow,
  type PaymentFlowType,
  type PaymentFlowGranularity,
  type PaymentsFlowQuery,
  type ProductRevenue,
  type Uuid,
} from '@openora/core/contracts';
import { DrizzleService, moneyAdd, moneySubtract } from '@openora/core/server';
import { game, gameRound, ledgerGame } from '@openora/core/casino/schema/gaming';
import { sportsbookBet, sportsbookBetTransaction } from '@openora/core/sportsbook/schema/betting';
import { wallet, walletTransaction } from '../schema/index.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;

const utcCreatedAt = sql`(${walletTransaction.createdAt} at time zone 'UTC')`;
const FLOW_BUCKETS: Record<PaymentFlowGranularity, SQL<string>> = {
  day: sql<string>`to_char(${utcCreatedAt}, 'YYYY-MM-DD')`,
  week: sql<string>`to_char(date_trunc('week', ${utcCreatedAt}), 'YYYY-MM-DD')`,
};
const dayAfter = (isoDay: string) => new Date(Date.parse(isoDay) + DAY_MS);

export class MoneyReportingService implements MoneyReportingPort {
  private sportsbookLedgerFound = false;

  constructor(private readonly drizzle: DrizzleService) {}

  async funnelActivity(userIds: readonly Uuid[]): Promise<MoneyFunnelActivity> {
    if (userIds.length === 0) {
      return { deposited: [], placedBet: [] };
    }
    const usersWith = async (type: 'deposit' | 'bet') => {
      const rows = await this.drizzle.db
        .selectDistinct({ userId: wallet.userId })
        .from(walletTransaction)
        .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
        .where(
          and(
            eq(walletTransaction.type, type),
            eq(walletTransaction.status, COMPLETED_STATUS),
            sql`${wallet.userId} = ANY(${sql.param([...userIds])}::uuid[])`,
          ),
        );
      return rows.map((row) => row.userId);
    };
    const [deposited, placedBet] = await Promise.all([usersWith('deposit'), usersWith('bet')]);
    return { deposited, placedBet };
  }

  private async hasSportsbookLedger(): Promise<boolean> {
    if (this.sportsbookLedgerFound) {
      return true;
    }
    const db = this.drizzle.db;
    const table = await db.execute<{ found: boolean }>(
      sql`select to_regclass('sportsbook_bet') is not null as found`,
    );
    if (table.rows[0]?.found !== true) {
      return false;
    }
    const bets = await db.execute<{ found: boolean }>(
      sql`select exists (select 1 from ${sportsbookBet}) as found`,
    );
    this.sportsbookLedgerFound = bets.rows[0]?.found === true;
    return this.sportsbookLedgerFound;
  }

  async summary({ dateFrom, dateTo, currency }: FinancialSummaryQuery): Promise<FinancialSummary> {
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

    const [deposits, withdrawals, sportsbookPromotionCost, byCurrency] = await Promise.all([
      totalsByRail('deposit'),
      totalsByRail('withdrawal'),
      this.hasSportsbookLedger().then((found) =>
        found ? this.sportsbookPromotionCost({ dateFrom, dateTo, currency }) : [],
      ),
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
      sportsbookPromotionCost,
      ngr: byCurrency.map((r) => ({ currency: r.currency, total: r.ngr })),
    };
  }

  private sportsbookPromotionCost(query: FinancialSummaryQuery) {
    const tx = sportsbookBetTransaction;
    const bet = sportsbookBet;
    const partOf = (kind: 'settle' | 'reopen') =>
      sql`coalesce(sum(${tx.promotionAmount}) filter (where ${tx.kind} = ${kind}), 0)`;
    return this.drizzle.db
      .select({
        currency: bet.currency,
        total: sql<string>`${partOf('settle')} - ${partOf('reopen')}`,
      })
      .from(tx)
      .innerJoin(bet, eq(bet.id, tx.betId))
      .where(
        and(
          gt(tx.promotionAmount, '0'),
          isNotNull(bet.promotionType),
          ...inRange(tx.createdAt, bet.currency, query),
        ),
      )
      .groupBy(bet.currency)
      .orderBy(bet.currency);
  }

  async products(query: FinancialSummaryQuery): Promise<ProductRevenue[]> {
    const db = this.drizzle.db;
    const bet = sportsbookBet;
    const tx = sportsbookBetTransaction;
    const prior = alias(sportsbookBetTransaction, 'prior_settle');
    const sportsbook = await this.hasSportsbookLedger();
    const book = <T>(query: () => Promise<T[]>) => (sportsbook ? query() : []);
    const product = sql<
      ProductRevenue['product']
    >`coalesce(${ledgerGame.gameType}::text, ${game.gameType}::text, ${sql.raw(`'${UNCLASSIFIED_PRODUCT}'`)})`;
    const [rounds, bookStakes, bookPayouts, bookReversals] = await Promise.all([
      db
        .select({
          product,
          currency: gameRound.currency,
          stakes: total(gameRound.betAmount),
          payouts: total(gameRound.winAmount),
        })
        .from(gameRound)
        .leftJoin(ledgerGame, eq(ledgerGame.gameId, gameRound.gameId))
        .leftJoin(game, eq(game.id, gameRound.gameId))
        .where(
          and(
            eq(gameRound.status, COMPLETED_STATUS),
            ...(sportsbook ? [ne(product, 'sportsbook')] : []),
            ...inRange(gameRound.startedAt, gameRound.currency, query),
          ),
        )
        .groupBy(product, gameRound.currency),
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
    const add = (
      product: ProductRevenue['product'],
      currency: string,
      stakes: string,
      payouts: string,
    ) => {
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

  async paymentsFlow({
    dateFrom,
    dateTo,
    granularity,
    types,
    statuses,
    currency,
  }: PaymentsFlowQuery): Promise<PaymentFlowRow[]> {
    const bucket = FLOW_BUCKETS[granularity];
    const type = sql<PaymentFlowType>`${walletTransaction.type}`;
    return this.drizzle.db
      .select({
        bucket,
        type,
        status: walletTransaction.status,
        currency: walletTransaction.currency,
        count: count(),
        amount: sql<string>`sum(${walletTransaction.amount})`,
      })
      .from(walletTransaction)
      .where(
        and(
          inArray(walletTransaction.type, [...types]),
          statuses ? inArray(walletTransaction.status, [...statuses]) : undefined,
          currency ? eq(walletTransaction.currency, currency) : undefined,
          gte(walletTransaction.createdAt, new Date(dateFrom)),
          lt(walletTransaction.createdAt, dayAfter(dateTo)),
        ),
      )
      .groupBy(bucket, walletTransaction.type, walletTransaction.status, walletTransaction.currency)
      .orderBy(
        asc(bucket),
        asc(walletTransaction.type),
        asc(walletTransaction.status),
        asc(walletTransaction.currency),
      )
      .limit(PAYMENTS_FLOW_MAX_ROWS + 1);
  }

  async ggr({ dateFrom, dateTo, currency, granularity }: FinancialGgrQuery): Promise<GgrSeries[]> {
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

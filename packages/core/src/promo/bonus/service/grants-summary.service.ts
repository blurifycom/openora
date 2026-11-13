import { and, count, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { moneyAdd, sumMoney, type DrizzleService } from '@openora/core/server';
import {
  dayRangeInstants,
  type BonusForfeitReason,
  type BonusGrantSource,
} from '@openora/core/contracts';
import {
  GRANTS_EXPIRING_SOON_DAYS,
  GRANTS_SUMMARY_MAX_CURRENCIES,
  resolveGrantsSummaryRange,
  type GrantsSummary,
  type GrantsSummaryCurrency,
  type GrantsSummaryInput,
} from '../contract/index.js';
import { promoGrant, promoGrantEntry } from '../schema/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ZERO = '0';

const grant = promoGrant;
const entry = promoGrantEntry;

type Counted = { count: number; amount: string };

const counted = (): Counted => ({ count: 0, amount: ZERO });
const add = (into: Counted, more: Counted) => {
  into.count += more.count;
  into.amount = moneyAdd(into.amount, more.amount);
};

function emptyCurrency(currency: string): GrantsSummaryCurrency {
  return {
    currency,
    granted: counted(),
    converted: counted(),
    expired: counted(),
    forfeited: { ...counted(), byReason: [] },
    cancelled: 0,
    bySource: [],
    outstanding: {
      activeGrants: 0,
      pendingGrants: 0,
      bonusBalance: ZERO,
      wageringRemaining: ZERO,
      expiringSoon: counted(),
    },
  };
}

function sourceOf(row: GrantsSummaryCurrency, source: BonusGrantSource) {
  let found = row.bySource.find((item) => item.source === source);
  if (!found) {
    found = { source, granted: counted(), converted: counted() };
    row.bySource.push(found);
  }
  return found;
}

function reasonCount(row: GrantsSummaryCurrency, reason: BonusForfeitReason, total: number) {
  const found = row.forfeited.byReason.find((item) => item.reason === reason);
  if (found) {
    found.count += total;
  } else {
    row.forfeited.byReason.push({ reason, count: total });
  }
}

/**
 * The operator's bonus grants per currency: what was granted and how grants ended in a range, read
 * off the grants themselves and the bonus ledger entries that closed them, and what the live ones
 * still hold now.
 */
export class GrantsSummaryService {
  constructor(private readonly drizzle: DrizzleService) {}

  async grantsSummary(
    { currency, source, ...dates }: GrantsSummaryInput,
    now = new Date(),
  ): Promise<GrantsSummary> {
    const range = resolveGrantsSummaryRange(dates, now);
    const { from, to } = dayRangeInstants(range);
    const narrowed = and(
      currency ? eq(grant.currency, currency.toUpperCase()) : undefined,
      source ? eq(grant.source, source) : undefined,
    );
    const soon = new Date(now.getTime() + GRANTS_EXPIRING_SOON_DAYS * DAY_MS);
    const active = eq(grant.status, 'active');
    const expiringSoon = sql`${active} and ${grant.expiresAt} <= ${soon}`;
    const db = this.drizzle.db;
    const [granted, ended, live] = await Promise.all([
      db
        .select({
          currency: grant.currency,
          source: grant.source,
          count: count(),
          amount: sumMoney(grant.grantedAmount),
        })
        .from(grant)
        .where(and(gte(grant.activatedAt, from), lte(grant.activatedAt, to), narrowed))
        .groupBy(grant.currency, grant.source),
      db
        .select({
          currency: grant.currency,
          source: grant.source,
          status: grant.status,
          reason: grant.forfeitReason,
          count: sql<number>`count(distinct ${grant.id})`.mapWith(Number),
          // A closing entry is negative: the bonus balance that left the grant.
          amount: sumMoney(sql`-${entry.bonusAmount}`),
        })
        .from(grant)
        .leftJoin(
          entry,
          and(
            eq(entry.grantId, grant.id),
            or(
              and(eq(grant.status, 'completed'), eq(entry.type, 'convert')),
              and(eq(grant.status, 'expired'), eq(entry.type, 'expire')),
              and(eq(grant.status, 'forfeited'), eq(entry.type, 'forfeit')),
            ),
          ),
        )
        .where(and(gte(grant.closedAt, from), lte(grant.closedAt, to), narrowed))
        .groupBy(grant.currency, grant.source, grant.status, grant.forfeitReason),
      db
        .select({
          currency: grant.currency,
          activeGrants: sql<number>`count(*) filter (where ${active})`.mapWith(Number),
          pendingGrants: sql<number>`count(*) filter (where ${grant.status} = 'pending')`.mapWith(
            Number,
          ),
          bonusBalance: sumMoney(grant.bonusBalance, active),
          wageringRemaining: sumMoney(
            sql`${grant.wageringRequired} - ${grant.wageringProgress}`,
            active,
          ),
          expiringSoonCount: sql<number>`count(*) filter (where ${expiringSoon})`.mapWith(Number),
          expiringSoonAmount: sumMoney(grant.bonusBalance, expiringSoon),
        })
        .from(grant)
        .where(and(inArray(grant.status, ['pending', 'active']), narrowed))
        .groupBy(grant.currency),
    ]);

    const byCurrency = new Map<string, GrantsSummaryCurrency>();
    const rowOf = (code: string) => {
      let row = byCurrency.get(code);
      if (!row) {
        row = emptyCurrency(code);
        byCurrency.set(code, row);
      }
      return row;
    };
    for (const { currency: code, source: cause, ...figures } of granted) {
      const row = rowOf(code);
      add(row.granted, figures);
      add(sourceOf(row, cause).granted, figures);
    }
    for (const { currency: code, source: cause, status, reason, ...figures } of ended) {
      const row = rowOf(code);
      if (status === 'completed') {
        add(row.converted, figures);
        add(sourceOf(row, cause).converted, figures);
      } else if (status === 'expired') {
        add(row.expired, figures);
      } else if (status === 'forfeited') {
        add(row.forfeited, figures);
        if (reason) {
          reasonCount(row, reason, figures.count);
        }
      } else if (status === 'cancelled') {
        row.cancelled += figures.count;
      }
    }
    for (const { currency: code, expiringSoonCount, expiringSoonAmount, ...figures } of live) {
      rowOf(code).outstanding = {
        ...figures,
        expiringSoon: { count: expiringSoonCount, amount: expiringSoonAmount },
      };
    }

    const currencies = [...byCurrency.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    );
    for (const row of currencies) {
      row.bySource.sort((a, b) => a.source.localeCompare(b.source));
      row.forfeited.byReason.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    }
    return {
      ...range,
      currencies: currencies.slice(0, GRANTS_SUMMARY_MAX_CURRENCIES),
      truncated: currencies.length > GRANTS_SUMMARY_MAX_CURRENCIES,
    };
  }
}

import { and, asc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import { dayRangeInstants } from '@openora/core/contracts';
import { sumMoney, type DrizzleService } from '@openora/core/server';
import {
  RAKEBACK_LIABILITY_MAX_CURRENCIES,
  resolveRakebackLiabilityRange,
  type RakebackLiabilityInput,
  type RakebackLiabilityReport,
} from '../contract/index.js';
import { promoRakebackAccrual } from '../schema/index.js';

const accrual = promoRakebackAccrual;

/** An amount, how many accruals and how many players make it, over the accruals `where` holds. */
const figures = (where: SQL) => ({
  amount: sumMoney(accrual.amount, where),
  accruals: sql<number>`count(*) filter (where ${where})`.mapWith(Number),
  players: sql<number>`count(distinct ${accrual.userId}) filter (where ${where})`.mapWith(Number),
});

/**
 * bonus.rakeback_liability: what rakeback the operator owes now and what accrued and was claimed
 * over a range, per currency, from the accruals alone - a reader over DRIZZLE, as the kernel builds
 * every tool's handler when it starts.
 */
export class RakebackLiabilityService {
  constructor(private readonly drizzle: DrizzleService) {}

  async report(
    { currency, ...dates }: RakebackLiabilityInput,
    now = new Date(),
  ): Promise<RakebackLiabilityReport> {
    const range = resolveRakebackLiabilityRange(dates, now);
    const { from, to } = dayRangeInstants(range);
    const unclaimed = eq(accrual.status, 'accrued');
    const accrued = and(gte(accrual.createdAt, from), lte(accrual.createdAt, to)) as SQL;
    const claimed = and(
      eq(accrual.status, 'claimed'),
      gte(accrual.settledAt, from),
      lte(accrual.settledAt, to),
    ) as SQL;
    const rows = await this.drizzle.db
      .select({
        currency: accrual.currency,
        unclaimedAmount: figures(unclaimed).amount,
        unclaimedAccruals: figures(unclaimed).accruals,
        unclaimedPlayers: figures(unclaimed).players,
        accruedAmount: figures(accrued).amount,
        accruedAccruals: figures(accrued).accruals,
        accruedPlayers: figures(accrued).players,
        claimedAmount: figures(claimed).amount,
        claimedAccruals: figures(claimed).accruals,
        claimedPlayers: figures(claimed).players,
      })
      .from(accrual)
      .where(
        and(
          or(unclaimed, accrued, claimed),
          currency ? eq(accrual.currency, currency.toUpperCase()) : undefined,
        ),
      )
      .groupBy(accrual.currency)
      .orderBy(asc(accrual.currency))
      .limit(RAKEBACK_LIABILITY_MAX_CURRENCIES + 1);
    return {
      ...range,
      currencies: rows.slice(0, RAKEBACK_LIABILITY_MAX_CURRENCIES).map((row) => ({
        currency: row.currency,
        unclaimed: {
          amount: row.unclaimedAmount,
          accruals: row.unclaimedAccruals,
          players: row.unclaimedPlayers,
        },
        accrued: {
          amount: row.accruedAmount,
          accruals: row.accruedAccruals,
          players: row.accruedPlayers,
        },
        claimed: {
          amount: row.claimedAmount,
          accruals: row.claimedAccruals,
          players: row.claimedPlayers,
        },
      })),
      truncated: rows.length > RAKEBACK_LIABILITY_MAX_CURRENCIES,
    };
  }
}

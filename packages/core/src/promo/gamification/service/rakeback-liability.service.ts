import { and, asc, eq, gte, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { dayRangeInstants } from '@openora/core/contracts';
import { sumMoney, type DrizzleService } from '@openora/core/server';
import {
  RAKEBACK_LIABILITY_MAX_CURRENCIES,
  resolveRakebackLiabilityRange,
  type RakebackLiabilityInput,
  type RakebackLiabilityReport,
} from '../contract/index.js';
import { promoRakebackAccrual, promoRankPeriodicReward } from '../schema/index.js';

const accrual = promoRakebackAccrual;
const reward = promoRankPeriodicReward;

/** An amount, how many accruals and how many players make it, over the accruals `where` holds. */
const figures = (where: SQL) => ({
  amount: sumMoney(accrual.amount, where),
  accruals: sql<number>`count(*) filter (where ${where})`.mapWith(Number),
  players: sql<number>`count(distinct ${accrual.userId}) filter (where ${where})`.mapWith(Number),
});

const rewardFigures = (where: SQL) => ({
  amount: sumMoney(reward.amount, where),
  rewards: sql<number>`count(*) filter (where ${where})`.mapWith(Number),
  players: sql<number>`count(distinct ${reward.userId}) filter (where ${where})`.mapWith(Number),
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
      rankRewards: await this.rankRewards(from, to, currency),
    };
  }

  private async rankRewards(from: Date, to: Date, currency: string | undefined) {
    const unclaimed = eq(reward.status, 'claimable');
    const created = and(gte(reward.createdAt, from), lte(reward.createdAt, to)) as SQL;
    const paid = and(
      ne(reward.status, 'claimable'),
      gte(reward.settledAt, from),
      lte(reward.settledAt, to),
    ) as SQL;
    const rows = await this.drizzle.db
      .select({
        currency: reward.currency,
        unclaimed: rewardFigures(unclaimed).amount,
        unclaimedRewards: rewardFigures(unclaimed).rewards,
        unclaimedPlayers: rewardFigures(unclaimed).players,
        created: rewardFigures(created).amount,
        createdRewards: rewardFigures(created).rewards,
        createdPlayers: rewardFigures(created).players,
        paid: rewardFigures(paid).amount,
        paidRewards: rewardFigures(paid).rewards,
        paidPlayers: rewardFigures(paid).players,
      })
      .from(reward)
      .where(
        and(
          or(unclaimed, created, paid),
          currency ? eq(reward.currency, currency.toUpperCase()) : undefined,
        ),
      )
      .groupBy(reward.currency)
      .orderBy(asc(reward.currency))
      .limit(RAKEBACK_LIABILITY_MAX_CURRENCIES + 1);
    return {
      currencies: rows.slice(0, RAKEBACK_LIABILITY_MAX_CURRENCIES).map((row) => ({
        currency: row.currency,
        unclaimed: {
          amount: row.unclaimed,
          rewards: row.unclaimedRewards,
          players: row.unclaimedPlayers,
        },
        created: { amount: row.created, rewards: row.createdRewards, players: row.createdPlayers },
        paid: { amount: row.paid, rewards: row.paidRewards, players: row.paidPlayers },
      })),
      truncated: rows.length > RAKEBACK_LIABILITY_MAX_CURRENCIES,
    };
  }
}

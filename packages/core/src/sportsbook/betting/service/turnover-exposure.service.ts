import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { sumMoney, type DrizzleService } from '@openora/core/server';
import { dayRangeInstants } from '@openora/core/contracts';
import { player } from '@openora/core/pam/schema/profile';
import {
  OpenBetStatusSchema,
  TURNOVER_EXPOSURE_MAX_CURRENCIES,
  resolveTurnoverExposureRange,
  type TurnoverExposure,
  type TurnoverExposureInput,
} from '../contract/index.js';
import { sportsbookBet } from '../schema/index.js';
import { betTotals, openBet } from './bet-query.service.js';

/** The operator's sportsbook turnover over a range and what its open bets stand to pay now. */
export class SportsbookTurnoverService {
  constructor(private readonly drizzle: DrizzleService) {}

  async turnoverExposure(
    { currency, largestOpen, ...dates }: TurnoverExposureInput,
    now = new Date(),
  ): Promise<TurnoverExposure> {
    const range = resolveTurnoverExposureRange(dates, now);
    const { from, to } = dayRangeInstants(range);
    const totals = betTotals({ dateFrom: from.toISOString(), dateTo: to.toISOString() });
    const bet = sportsbookBet;
    const inCurrency = currency ? eq(bet.currency, currency.toUpperCase()) : undefined;
    const db = this.drizzle.db;
    const ranked = db
      .select({
        currency: bet.currency,
        betId: sql<string>`${bet.id}`.as('bet_id'),
        playerId: sql<string | null>`${player.id}`.as('player_id'),
        status: bet.status,
        stake: bet.stake,
        potentialPayout: bet.potentialPayout,
        legs: sql<number>`jsonb_array_length(${bet.legs})`.as('legs'),
        placedAt: bet.createdAt,
        lastLegStartsAt: bet.lastLegStartsAt,
        // The bet id breaks ties, so equal payouts always rank in the same order.
        rank: sql<number>`row_number() over (partition by ${bet.currency} order by ${bet.potentialPayout} desc, ${bet.id})`.as(
          'rank',
        ),
      })
      .from(bet)
      .leftJoin(player, eq(player.userId, bet.userId))
      .where(and(openBet, inCurrency))
      .as('ranked');
    const [rows, largest] = await Promise.all([
      db
        .select({
          ...totals.columns,
          openBets: sql<number>`count(*) filter (where ${openBet})`.mapWith(Number),
          openPotentialPayout: sumMoney(bet.potentialPayout, openBet),
        })
        .from(bet)
        .where(and(totals.read, inCurrency))
        .groupBy(bet.currency)
        .orderBy(asc(bet.currency))
        .limit(TURNOVER_EXPOSURE_MAX_CURRENCIES + 1),
      largestOpen === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(ranked)
            .where(lte(ranked.rank, largestOpen))
            .orderBy(asc(ranked.currency), asc(ranked.rank)),
    ]);
    return {
      ...range,
      currencies: rows.slice(0, TURNOVER_EXPOSURE_MAX_CURRENCIES).map((row) => ({
        ...row,
        largestOpen: largest
          .filter((open) => open.currency === row.currency)
          .map((open) => ({
            betId: open.betId,
            playerId: open.playerId,
            status: OpenBetStatusSchema.parse(open.status),
            stake: open.stake,
            potentialPayout: open.potentialPayout,
            legs: Number(open.legs),
            placedAt: new Date(open.placedAt).toISOString(),
            lastLegStartsAt: new Date(open.lastLegStartsAt).toISOString(),
          })),
      })),
      truncated: rows.length > TURNOVER_EXPOSURE_MAX_CURRENCIES,
    };
  }
}

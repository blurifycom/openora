import { and, count, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import {
  dayRangeInstants,
  userIdOfPlayer,
  withPlayerIds,
  type IdentityReader,
} from '@openora/core/contracts';
import {
  resolveBetsFindRange,
  type BetsFind,
  type BetsFindInput,
  type BetsFindSortBy,
} from '../contract/index.js';
import { sportsbookBet } from '../schema/index.js';

const bet = sportsbookBet;

const SORT_COLUMNS: Record<BetsFindSortBy, SQL> = {
  placedAt: sql`${bet.createdAt}`,
  stake: sql`${bet.stake}`,
  potentialPayout: sql`${bet.potentialPayout}`,
};

/** Finds sportsbook bets across all players, each by player id and without its selections. */
export class BetsFindService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly identity: IdentityReader,
  ) {}

  async find(
    {
      status,
      result,
      playerId,
      currency,
      minStake,
      sortBy,
      sortDir,
      limit,
      ...days
    }: BetsFindInput,
    now = new Date(),
  ): Promise<BetsFind> {
    const range = resolveBetsFindRange(days, now);
    const { from, to } = dayRangeInstants(range);
    const db = this.drizzle.db;
    // The player id names a user through IDENTITY_READER; an unknown one matches nothing.
    const playerUserId = playerId ? await userIdOfPlayer(this.identity, playerId) : null;
    const where = and(
      gte(bet.createdAt, from),
      lte(bet.createdAt, to),
      status?.length ? inArray(bet.status, status) : undefined,
      result?.length ? inArray(bet.result, result) : undefined,
      playerId ? (playerUserId === null ? sql`false` : eq(bet.userId, playerUserId)) : undefined,
      currency ? eq(bet.currency, currency.toUpperCase()) : undefined,
      minStake ? gte(bet.stake, minStake) : undefined,
    );
    const direction = sql.raw(sortDir);
    const [rows, totals] = await Promise.all([
      db
        .select({
          betId: bet.id,
          userId: bet.userId,
          status: bet.status,
          result: bet.result,
          currency: bet.currency,
          stake: bet.stake,
          potentialPayout: bet.potentialPayout,
          payoutTotal: bet.payoutTotal,
          legs: sql<number>`jsonb_array_length(${bet.legs})`.mapWith(Number),
          placedAt: bet.createdAt,
          settledAt: bet.settledAt,
        })
        .from(bet)
        .where(where)
        // The bet id breaks ties, so equal figures always list in the same order.
        .orderBy(sql`${SORT_COLUMNS[sortBy]} ${direction}`, sql`${bet.id} ${direction}`)
        .limit(limit + 1),
      db.select({ total: count() }).from(bet).where(where),
    ]);
    return {
      placedFrom: range.dateFrom,
      placedTo: range.dateTo,
      total: totals[0]?.total ?? 0,
      truncated: rows.length > limit,
      bets: (await withPlayerIds(this.identity, rows.slice(0, limit))).map((row) => ({
        ...row,
        placedAt: row.placedAt.toISOString(),
        settledAt: row.settledAt?.toISOString() ?? null,
      })),
    };
  }
}

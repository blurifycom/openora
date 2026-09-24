import type {
  AdminGameReporting,
  GamePerformanceFilter,
  GamePerformanceRow,
  GamePerformanceTrend,
  GamePerformanceTrendFilter,
  PlayerGameStats,
} from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { game, gameRound } from './schema/index.js';

// See ADR-0017/0025.
export class DrizzleAdminGameReporting implements AdminGameReporting {
  constructor(private readonly drizzle: DrizzleService) {}

  async listGamePerformance(filter: GamePerformanceFilter): Promise<GamePerformanceRow[]> {
    const db = this.drizzle.db;

    // status/date/currency filters scope which ROUNDS count towards a game's metrics,
    // so they live in the join condition, not WHERE - a game with zero completed rounds
    // in range still appears with all-zero metrics rather than being dropped from the
    // report. `gameType` narrows which GAMES appear at all, so it stays in WHERE.
    const joinConditions = [
      eq(gameRound.gameId, game.id),
      eq(gameRound.status, 'completed'),
      filter.dateFrom ? gte(gameRound.startedAt, filter.dateFrom) : undefined,
      filter.dateTo ? lte(gameRound.startedAt, filter.dateTo) : undefined,
      // No currency filter mixes bet/win amounts across currencies into one unconverted
      // sum - the operator UI shows a disclaimer in that case; this is intentional.
      filter.currency ? eq(gameRound.currency, filter.currency) : undefined,
    ].filter(Boolean);
    if (filter.gameIds?.length === 0) {
      return [];
    }
    const where = and(
      filter.gameType ? eq(game.gameType, filter.gameType) : undefined,
      // One array parameter: the list can run to thousands of ids.
      filter.gameIds ? sql`${game.id} = ANY(${sql.param([...filter.gameIds])}::uuid[])` : undefined,
    );

    const volume = sql<string>`coalesce(sum(${gameRound.betAmount}), 0)`;
    // GGR - can be negative when a game pays out more than it takes in over the range.
    const revenue = sql<string>`coalesce(sum(${gameRound.betAmount}) - sum(${gameRound.winAmount}), 0)`;
    const uniquePlayers = sql<number>`count(distinct ${gameRound.userId})`;
    const roundsPlayed = sql<number>`count(${gameRound.id})`;

    const sortColumns = {
      name: game.name,
      gameType: game.gameType,
      volume,
      revenue,
      uniquePlayers,
      roundsPlayed,
    };
    const order = filter.sortDir === 'asc' ? asc : desc;

    const rows = await db
      .select({
        gameId: game.id,
        name: game.name,
        gameType: game.gameType,
        volume,
        revenue,
        uniquePlayers,
        roundsPlayed,
      })
      .from(game)
      .leftJoin(gameRound, and(...joinConditions))
      .where(where)
      .groupBy(game.id, game.name, game.gameType)
      .orderBy(order(sortColumns[filter.sortBy ?? 'volume']));

    return rows.map((r) => ({
      gameId: r.gameId,
      name: r.name,
      gameType: r.gameType,
      volume: r.volume,
      revenue: r.revenue,
      uniquePlayers: Number(r.uniquePlayers),
      roundsPlayed: Number(r.roundsPlayed),
    }));
  }

  async getGamePerformanceTrend(
    filter: GamePerformanceTrendFilter,
  ): Promise<GamePerformanceTrend | null> {
    const db = this.drizzle.db;
    const [found] = await db
      .select({ id: game.id })
      .from(game)
      .where(eq(game.id, filter.gameId))
      .limit(1);
    if (!found) {
      return null;
    }

    const unit = filter.granularity;
    const step = `1 ${unit}`;
    const currency = filter.currency ? sql`and ${gameRound.currency} = ${filter.currency}` : sql``;

    // Buckets are truncated in UTC so they do not shift with the session time zone.
    // One statement with grouping sets keeps the totals row and the per-bucket rows on
    // the same snapshot, so the points always sum to the totals.
    const result = await db.execute<{
      bucket: string | null;
      volume: string;
      revenue: string;
      unique_players: string | number;
      rounds_played: string | number;
    }>(sql`
      with buckets as (
        select generate_series(
          date_trunc(${unit}, ${filter.dateFrom}::timestamptz at time zone 'UTC'),
          date_trunc(${unit}, ${filter.dateTo}::timestamptz at time zone 'UTC'),
          ${step}::interval
        ) as bucket
      ),
      rounds as (
        select
          date_trunc(${unit}, ${gameRound.startedAt} at time zone 'UTC') as bucket,
          ${gameRound.betAmount} as bet_amount,
          ${gameRound.winAmount} as win_amount,
          ${gameRound.userId} as user_id
        from ${gameRound}
        where ${gameRound.gameId} = ${filter.gameId}
          and ${gameRound.status} = 'completed'
          and ${gameRound.startedAt} >= ${filter.dateFrom}
          and ${gameRound.startedAt} <= ${filter.dateTo}
          ${currency}
      )
      select
        to_char(b.bucket, 'YYYY-MM-DD') as bucket,
        coalesce(sum(r.bet_amount), 0) as volume,
        coalesce(sum(r.bet_amount) - sum(r.win_amount), 0) as revenue,
        count(distinct r.user_id) as unique_players,
        count(r.user_id) as rounds_played
      from buckets b
      left join rounds r on r.bucket = b.bucket
      group by grouping sets ((b.bucket), ())
      order by grouping(b.bucket) desc, b.bucket
    `);

    const [totals, ...points] = result.rows;
    return {
      totals: {
        volume: totals?.volume ?? '0',
        revenue: totals?.revenue ?? '0',
        uniquePlayers: Number(totals?.unique_players ?? 0),
        roundsPlayed: Number(totals?.rounds_played ?? 0),
      },
      points: points.map((p) => ({
        bucket: String(p.bucket),
        volume: p.volume,
        revenue: p.revenue,
        roundsPlayed: Number(p.rounds_played),
      })),
    };
  }

  async getPlayerStats(userId: string): Promise<PlayerGameStats> {
    const db = this.drizzle.db;
    const [row] = await db
      .select({
        totalWagered: sql<string>`coalesce(sum(${gameRound.betAmount}), 0)`,
        totalBets: sql<number>`count(${gameRound.id})`,
      })
      .from(gameRound)
      .where(and(eq(gameRound.userId, userId), eq(gameRound.status, 'completed')));
    return {
      totalWagered: row?.totalWagered ?? '0',
      totalBets: Number(row?.totalBets ?? 0),
    };
  }
}

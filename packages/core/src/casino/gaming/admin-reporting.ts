import type {
  AdminGameReporting,
  GamePerformanceFilter,
  GamePerformanceRow,
} from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { game, gameRound } from './schema/index.js';

// See ADR-0017/0025.
export class DrizzleAdminGameReporting implements AdminGameReporting {
  constructor(private readonly drizzle: DrizzleService) {}

  async listGamePerformance(filter: GamePerformanceFilter): Promise<GamePerformanceRow[]> {
    const db = this.drizzle.db;

    // status/date filters scope which ROUNDS count towards a game's metrics, so they
    // live in the join condition, not WHERE - a game with zero completed rounds in
    // range still appears with all-zero metrics rather than being dropped from the
    // report. `gameType` narrows which GAMES appear at all, so it stays in WHERE.
    const joinConditions = [
      eq(gameRound.gameId, game.id),
      eq(gameRound.status, 'completed'),
      filter.dateFrom ? gte(gameRound.startedAt, filter.dateFrom) : undefined,
      filter.dateTo ? lte(gameRound.startedAt, filter.dateTo) : undefined,
    ].filter(Boolean);
    const where = filter.gameType ? eq(game.gameType, filter.gameType) : undefined;

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
}

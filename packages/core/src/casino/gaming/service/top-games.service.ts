import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { DrizzleService } from '@openora/core/server';
import { dayRangeInstants } from '@openora/core/contracts';
import {
  TOP_GAMES_MAX_CURRENCIES,
  resolveTopGamesRange,
  type TopGames,
  type TopGamesInput,
  type TopGamesSortBy,
} from '../contract/index.js';
import { game, gameProvider, gameRound } from '../schema/index.js';

const volume = sql<string>`sum(${gameRound.betAmount})::numeric(38, 18)`;
// GGR: negative when the games paid out more than they took in.
const revenue = sql<string>`(sum(${gameRound.betAmount}) - sum(${gameRound.winAmount}))::numeric(38, 18)`;
const roundsPlayed = sql<number>`count(*)`.mapWith(Number);
const uniquePlayers = sql<number>`count(distinct ${gameRound.userId})`.mapWith(Number);

const SORT_FIGURES: Record<TopGamesSortBy, SQL> = {
  volume,
  revenue,
  roundsPlayed: sql`count(*)`,
  uniquePlayers: sql`count(distinct ${gameRound.userId})`,
};

/**
 * The games ranked by their completed rounds per currency, over the same rounds the back office
 * game performance report reads (ADMIN_GAME_REPORTING): stakes net of reversed stakes, wins, and
 * who played.
 */
export class TopGamesService {
  constructor(private readonly drizzle: DrizzleService) {}

  async topGames(
    { currency, gameType, sortBy, sortDir, limit, ...dates }: TopGamesInput,
    now = new Date(),
  ): Promise<TopGames> {
    const range = resolveTopGamesRange(dates, now);
    const { from, to } = dayRangeInstants(range);
    const rounds = and(
      eq(gameRound.status, 'completed'),
      gte(gameRound.startedAt, from),
      lte(gameRound.startedAt, to),
      currency ? eq(gameRound.currency, currency.toUpperCase()) : undefined,
      gameType ? eq(game.gameType, gameType) : undefined,
    );
    const db = this.drizzle.db;
    const figure = SORT_FIGURES[sortBy];
    const order = sortDir === 'asc' ? sql`asc` : sql`desc`;
    const ranked = db
      .select({
        currency: gameRound.currency,
        gameId: game.id,
        name: sql<string>`${game.name}`.as('name'),
        provider: sql<string>`${gameProvider.name}`.as('provider'),
        gameType: game.gameType,
        volume: volume.as('volume'),
        revenue: revenue.as('revenue'),
        roundsPlayed: roundsPlayed.as('rounds_played'),
        uniquePlayers: uniquePlayers.as('unique_players'),
        // The game id breaks ties, so equal figures always rank in the same order.
        rank: sql<number>`row_number() over (partition by ${gameRound.currency} order by ${figure} ${order}, ${game.id})`.as(
          'rank',
        ),
      })
      .from(gameRound)
      .innerJoin(game, eq(game.id, gameRound.gameId))
      .innerJoin(gameProvider, eq(gameProvider.id, game.providerId))
      .where(rounds)
      .groupBy(gameRound.currency, game.id, gameProvider.name)
      .as('ranked');
    const [totals, games] = await Promise.all([
      db
        .select({
          currency: gameRound.currency,
          volume,
          revenue,
          roundsPlayed,
          uniquePlayers,
          gamesPlayed: sql<number>`count(distinct ${gameRound.gameId})`.mapWith(Number),
        })
        .from(gameRound)
        .innerJoin(game, eq(game.id, gameRound.gameId))
        .where(rounds)
        .groupBy(gameRound.currency)
        .orderBy(asc(gameRound.currency))
        .limit(TOP_GAMES_MAX_CURRENCIES + 1),
      db
        .select()
        .from(ranked)
        .where(lte(ranked.rank, limit))
        .orderBy(asc(ranked.currency), asc(ranked.rank)),
    ]);
    const kept = totals.slice(0, TOP_GAMES_MAX_CURRENCIES);
    return {
      ...range,
      sortBy,
      sortDir,
      currencies: kept.map(({ currency: code, ...figures }) => ({
        currency: code,
        totals: figures,
        games: games
          .filter((row) => row.currency === code)
          .map((row) => ({
            gameId: row.gameId,
            name: row.name,
            provider: row.provider,
            gameType: row.gameType,
            volume: row.volume,
            revenue: row.revenue,
            roundsPlayed: Number(row.roundsPlayed),
            uniquePlayers: Number(row.uniquePlayers),
          })),
      })),
      truncated: totals.length > TOP_GAMES_MAX_CURRENCIES,
    };
  }
}

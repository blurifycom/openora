import type {
  AdminGameReporting,
  GameCurrencyRanking,
  GameCurrencyRankingFilter,
  GameRankingSortBy,
  GamePerformanceFilter,
  GamePerformanceRow,
  GamePerformanceTrend,
  GamePerformanceTrendFilter,
  GameRoundCount,
  GameRoundRankingFilter,
  GameRoundTopFilter,
  PlayerGameStats,
  ProviderCurrencyRanking,
  ProviderCurrencyRankingFilter,
  ProviderRankingSortBy,
} from '@openora/core/contracts';
import { UNCLASSIFIED_GAME_TYPE } from '@openora/core/contracts';
import { DrizzleService, sumMoney } from '@openora/core/server';
import { and, asc, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { union } from 'drizzle-orm/pg-core';
import { game, gameProvider, gameRound, ledgerGame } from './schema/index.js';

const rankedVolume = sumMoney(gameRound.betAmount);
const rankedRevenue = sql<string>`(${sumMoney(gameRound.betAmount)} - ${sumMoney(gameRound.winAmount)})::numeric(38, 18)`;
const rankedRounds = sql<number>`count(*)`.mapWith(Number);
const rankedPlayers = sql<number>`count(distinct ${gameRound.userId})`.mapWith(Number);

const RANKING_FIGURES: Record<GameRankingSortBy, SQL> = {
  volume: rankedVolume,
  revenue: rankedRevenue,
  roundsPlayed: sql`count(*)`,
  uniquePlayers: sql`count(distinct ${gameRound.userId})`,
};

const rankedGames = sql<number>`count(distinct ${gameRound.gameId})`.mapWith(Number);

const PROVIDER_RANKING_FIGURES: Record<ProviderRankingSortBy, SQL> = {
  ...RANKING_FIGURES,
  gamesPlayed: sql`count(distinct ${gameRound.gameId})`,
};

export class DrizzleAdminGameReporting implements AdminGameReporting {
  constructor(private readonly drizzle: DrizzleService) {}

  async listGamePerformance(filter: GamePerformanceFilter): Promise<GamePerformanceRow[]> {
    const db = this.drizzle.db;

    const roundsInRange = [
      eq(gameRound.status, 'completed'),
      filter.dateFrom ? gte(gameRound.startedAt, filter.dateFrom) : undefined,
      filter.dateTo ? lte(gameRound.startedAt, filter.dateTo) : undefined,
      filter.currency ? eq(gameRound.currency, filter.currency) : undefined,
    ].filter(Boolean);
    const games = union(
      db.select({ id: game.id }).from(game),
      db.select({ id: ledgerGame.gameId }).from(ledgerGame),
      db
        .select({ id: gameRound.gameId })
        .from(gameRound)
        .where(and(...roundsInRange)),
    ).as('games');
    const gameId = games.id;
    const gameType = sql<
      GamePerformanceRow['gameType']
    >`coalesce(${game.gameType}::text, ${ledgerGame.gameType}::text, ${sql.raw(`'${UNCLASSIFIED_GAME_TYPE}'`)})`;
    const name = sql<string>`coalesce(${game.name}, ${games.id}::text)`;
    if (filter.gameIds?.length === 0) {
      return [];
    }
    const where = and(
      filter.gameType ? eq(gameType, filter.gameType) : undefined,
      filter.gameIds ? sql`${gameId} = ANY(${sql.param([...filter.gameIds])}::uuid[])` : undefined,
    );

    const volume = sql<string>`coalesce(sum(${gameRound.betAmount}), 0)`;
    const revenue = sql<string>`coalesce(sum(${gameRound.betAmount}) - sum(${gameRound.winAmount}), 0)`;
    const uniquePlayers = sql<number>`count(distinct ${gameRound.userId})`;
    const roundsPlayed = sql<number>`count(${gameRound.id})`;

    const sortColumns = {
      name,
      gameType,
      volume,
      revenue,
      uniquePlayers,
      roundsPlayed,
    };
    const order = filter.sortDir === 'asc' ? asc : desc;

    const rows = await db
      .select({ gameId, name, gameType, volume, revenue, uniquePlayers, roundsPlayed })
      .from(games)
      .leftJoin(game, eq(game.id, games.id))
      .leftJoin(ledgerGame, eq(ledgerGame.gameId, games.id))
      .leftJoin(gameRound, and(eq(gameRound.gameId, games.id), ...roundsInRange))
      .where(where)
      .groupBy(gameId, name, gameType)
      .orderBy(order(sortColumns[filter.sortBy ?? 'volume']), asc(gameId));

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

  rankGamesByRounds({ gameIds, ...filter }: GameRoundRankingFilter): Promise<GameRoundCount[]> {
    if (gameIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.rankByRounds(
      filter,
      sql`${gameRound.gameId} = ANY(${sql.param([...gameIds])}::uuid[])`,
    );
  }

  rankAllGamesByRounds(filter: GameRoundTopFilter): Promise<GameRoundCount[]> {
    return this.rankByRounds(filter);
  }

  async rankGamesPerCurrency({
    dateFrom,
    dateTo,
    currency,
    gameType,
    sortBy,
    sortDir,
    limit,
    maxCurrencies,
  }: GameCurrencyRankingFilter): Promise<GameCurrencyRanking> {
    const rounds = and(
      eq(gameRound.status, 'completed'),
      gte(gameRound.startedAt, dateFrom),
      lte(gameRound.startedAt, dateTo),
      currency ? eq(gameRound.currency, currency) : undefined,
      gameType ? eq(game.gameType, gameType) : undefined,
    );
    const db = this.drizzle.db;
    const order = sortDir === 'asc' ? sql`asc` : sql`desc`;
    const ranked = db
      .select({
        currency: gameRound.currency,
        gameId: game.id,
        name: sql<string>`${game.name}`.as('name'),
        provider: sql<string>`${gameProvider.name}`.as('provider'),
        gameType: game.gameType,
        volume: rankedVolume.as('volume'),
        revenue: rankedRevenue.as('revenue'),
        roundsPlayed: rankedRounds.as('rounds_played'),
        uniquePlayers: rankedPlayers.as('unique_players'),
        rank: sql<number>`row_number() over (partition by ${gameRound.currency} order by ${RANKING_FIGURES[sortBy]} ${order}, ${game.id})`.as(
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
          volume: rankedVolume,
          revenue: rankedRevenue,
          roundsPlayed: rankedRounds,
          uniquePlayers: rankedPlayers,
          gamesPlayed: sql<number>`count(distinct ${gameRound.gameId})`.mapWith(Number),
        })
        .from(gameRound)
        .innerJoin(game, eq(game.id, gameRound.gameId))
        .where(rounds)
        .groupBy(gameRound.currency)
        .orderBy(asc(gameRound.currency))
        .limit(maxCurrencies + 1),
      db
        .select()
        .from(ranked)
        .where(lte(ranked.rank, limit))
        .orderBy(asc(ranked.currency), asc(ranked.rank)),
    ]);
    return {
      currencies: totals.slice(0, maxCurrencies).map(({ currency: code, ...figures }) => ({
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
      truncated: totals.length > maxCurrencies,
    };
  }

  async rankProvidersPerCurrency({
    dateFrom,
    dateTo,
    currency,
    gameType,
    sortBy,
    sortDir,
    limit,
    maxCurrencies,
  }: ProviderCurrencyRankingFilter): Promise<ProviderCurrencyRanking> {
    const rounds = and(
      eq(gameRound.status, 'completed'),
      gte(gameRound.startedAt, dateFrom),
      lte(gameRound.startedAt, dateTo),
      currency ? eq(gameRound.currency, currency) : undefined,
      gameType ? eq(game.gameType, gameType) : undefined,
    );
    const db = this.drizzle.db;
    const order = sortDir === 'asc' ? sql`asc` : sql`desc`;
    const ranked = db
      .select({
        currency: gameRound.currency,
        providerId: gameProvider.id,
        name: sql<string>`${gameProvider.name}`.as('name'),
        slug: sql<string>`${gameProvider.slug}`.as('slug'),
        volume: rankedVolume.as('volume'),
        revenue: rankedRevenue.as('revenue'),
        roundsPlayed: rankedRounds.as('rounds_played'),
        uniquePlayers: rankedPlayers.as('unique_players'),
        gamesPlayed: rankedGames.as('games_played'),
        rank: sql<number>`row_number() over (partition by ${gameRound.currency} order by ${PROVIDER_RANKING_FIGURES[sortBy]} ${order}, ${gameProvider.id})`.as(
          'rank',
        ),
      })
      .from(gameRound)
      .innerJoin(game, eq(game.id, gameRound.gameId))
      .innerJoin(gameProvider, eq(gameProvider.id, game.providerId))
      .where(rounds)
      .groupBy(gameRound.currency, gameProvider.id)
      .as('ranked');
    const [totals, providers] = await Promise.all([
      db
        .select({
          currency: gameRound.currency,
          volume: rankedVolume,
          revenue: rankedRevenue,
          roundsPlayed: rankedRounds,
          uniquePlayers: rankedPlayers,
          gamesPlayed: rankedGames,
          providersPlayed: sql<number>`count(distinct ${game.providerId})`.mapWith(Number),
        })
        .from(gameRound)
        .innerJoin(game, eq(game.id, gameRound.gameId))
        .where(rounds)
        .groupBy(gameRound.currency)
        .orderBy(asc(gameRound.currency))
        .limit(maxCurrencies + 1),
      db
        .select()
        .from(ranked)
        .where(lte(ranked.rank, limit))
        .orderBy(asc(ranked.currency), asc(ranked.rank)),
    ]);
    return {
      currencies: totals.slice(0, maxCurrencies).map(({ currency: code, ...figures }) => ({
        currency: code,
        totals: figures,
        providers: providers
          .filter((row) => row.currency === code)
          .map((row) => ({
            providerId: row.providerId,
            name: row.name,
            slug: row.slug,
            volume: row.volume,
            revenue: row.revenue,
            roundsPlayed: Number(row.roundsPlayed),
            uniquePlayers: Number(row.uniquePlayers),
            gamesPlayed: Number(row.gamesPlayed),
          })),
      })),
      truncated: totals.length > maxCurrencies,
    };
  }

  private async rankByRounds(
    { dateFrom, dateTo, limit }: GameRoundTopFilter,
    gameCondition?: SQL,
  ): Promise<GameRoundCount[]> {
    if (limit <= 0) {
      return [];
    }
    const roundsPlayed = count(gameRound.id);
    const rows = await this.drizzle.db
      .select({ gameId: gameRound.gameId, roundsPlayed })
      .from(gameRound)
      .where(
        and(
          gameCondition,
          eq(gameRound.status, 'completed'),
          gte(gameRound.startedAt, dateFrom),
          lte(gameRound.startedAt, dateTo),
        ),
      )
      .groupBy(gameRound.gameId)
      .orderBy(desc(roundsPlayed), asc(gameRound.gameId))
      .limit(limit);
    return rows.map((row) => ({ gameId: row.gameId, roundsPlayed: Number(row.roundsPlayed) }));
  }

  async getGamePerformanceTrend(
    filter: GamePerformanceTrendFilter,
  ): Promise<GamePerformanceTrend | null> {
    const db = this.drizzle.db;
    const {
      rows: [known],
    } = await db.execute<{ found: boolean }>(sql`select
      exists (select 1 from ${game} where ${game.id} = ${filter.gameId})
      or exists (select 1 from ${ledgerGame} where ${ledgerGame.gameId} = ${filter.gameId})
      or exists (select 1 from ${gameRound} where ${gameRound.gameId} = ${filter.gameId}) as found`);
    if (!known?.found) {
      return null;
    }

    const unit = filter.granularity;
    const step = `1 ${unit}`;
    const currency = filter.currency ? sql`and ${gameRound.currency} = ${filter.currency}` : sql``;

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

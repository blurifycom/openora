import { createToken, type Token } from './token.js';
import type { GameType } from '../schemas/game.js';
import type { Granularity } from '../schemas/reporting.js';

/**
 * Admin/back-office reporting over game performance. Owned + bound by the
 * casino/gaming module (it owns the `game`/`gameRound` tables); the back-office
 * depends only on this port, never on the gaming schema. A query port like
 * ADMIN_WALLET_REPORTING. See ADR-0017/0025.
 */

export const GAME_PERFORMANCE_SORT_FIELDS = [
  'name',
  'gameType',
  'volume',
  'revenue',
  'uniquePlayers',
  'roundsPlayed',
] as const;
export type GamePerformanceSortBy = (typeof GAME_PERFORMANCE_SORT_FIELDS)[number];

export type GamePerformanceFilter = {
  dateFrom?: Date;
  dateTo?: Date;
  gameType?: GameType;
  /** Narrows which games appear at all, like `gameType`. An empty list matches nothing. */
  gameIds?: readonly string[];
  currency?: string;
  sortBy?: GamePerformanceSortBy;
  sortDir?: 'asc' | 'desc';
};

/**
 * volume/revenue = SUM(gameRound.betAmount) / SUM(betAmount) - SUM(winAmount) over
 * status='completed' rounds in range; revenue (GGR) can be negative. uniquePlayers/
 * roundsPlayed are 0 for a game with no completed rounds in range - games are never
 * omitted just because they had no activity in the requested window.
 */
export type GamePerformanceRow = {
  gameId: string;
  name: string;
  gameType: GameType;
  volume: string;
  revenue: string;
  uniquePlayers: number;
  roundsPlayed: number;
};

export type GamePerformanceTrendFilter = {
  gameId: string;
  dateFrom: Date;
  dateTo: Date;
  granularity: Granularity;
  currency?: string;
};

/** A bucket is the UTC start of its day, ISO week (Monday) or month, as `YYYY-MM-DD`. */
export type GamePerformanceTrendPoint = {
  bucket: string;
  volume: string;
  revenue: string;
  roundsPlayed: number;
};

/**
 * One game's metrics over [dateFrom, dateTo], with the same round scoping as
 * GamePerformanceRow. `points` holds every bucket in range, zero-filled, and sums to
 * `totals`; `uniquePlayers` is totals-only because distinct counts do not add up.
 */
export type GamePerformanceTrend = {
  totals: {
    volume: string;
    revenue: string;
    uniquePlayers: number;
    roundsPlayed: number;
  };
  points: GamePerformanceTrendPoint[];
};

export type GameRoundRankingFilter = {
  dateFrom: Date;
  dateTo: Date;
  /** Only these games are counted. An empty list matches nothing. */
  gameIds: readonly string[];
  limit: number;
};

export type GameRoundTopFilter = Omit<GameRoundRankingFilter, 'gameIds'>;

/** A game with at least one completed round in range, and how many it had. */
export type GameRoundCount = {
  gameId: string;
  roundsPlayed: number;
};

/** The figures `listGamePerformance` reports, which a per-currency ranking orders by. */
export type GameRankingSortBy = Exclude<GamePerformanceSortBy, 'name' | 'gameType'>;

export type GameCurrencyRankingFilter = {
  dateFrom: Date;
  dateTo: Date;
  currency?: string;
  gameType?: GameType;
  sortBy: GameRankingSortBy;
  sortDir: 'asc' | 'desc';
  /** Games listed per currency. */
  limit: number;
  /** Currencies listed, alphabetical; `truncated` says more had rounds. */
  maxCurrencies: number;
};

export type GameRankingFigures = {
  volume: string;
  revenue: string;
  roundsPlayed: number;
  uniquePlayers: number;
};

/**
 * Per currency, its totals over every game with a completed round in range and at most `limit`
 * of those games by `sortBy`, ties by game id; a game with no such round is left out. The same
 * round scoping as listGamePerformance, which without a currency sums across currencies.
 */
export type GameCurrencyRanking = {
  currencies: {
    currency: string;
    totals: GameRankingFigures & { gamesPlayed: number };
    games: (GameRankingFigures & {
      gameId: string;
      name: string;
      provider: string;
      gameType: GameType;
    })[];
  }[];
  truncated: boolean;
};

/** What a per-currency provider ranking orders by: the game figures, or how many games played. */
export type ProviderRankingSortBy = GameRankingSortBy | 'gamesPlayed';

export type ProviderCurrencyRankingFilter = Omit<GameCurrencyRankingFilter, 'sortBy' | 'limit'> & {
  sortBy: ProviderRankingSortBy;
  /** Providers listed per currency. */
  limit: number;
};

/**
 * Per currency, its totals over every provider whose games had a completed round in range and at
 * most `limit` of those providers by `sortBy`, ties by provider id, each summing its games' rounds
 * as GameCurrencyRanking does.
 */
export type ProviderCurrencyRanking = {
  currencies: {
    currency: string;
    totals: GameRankingFigures & { providersPlayed: number; gamesPlayed: number };
    providers: (GameRankingFigures & {
      providerId: string;
      name: string;
      slug: string;
      gamesPlayed: number;
    })[];
  }[];
  truncated: boolean;
};

export type PlayerGameStats = {
  totalWagered: string;
  totalBets: number;
};

export type AdminGameReporting = {
  listGamePerformance(filter: GamePerformanceFilter): Promise<GamePerformanceRow[]>;
  /** `null` when no game has `filter.gameId`. */
  getGamePerformanceTrend(filter: GamePerformanceTrendFilter): Promise<GamePerformanceTrend | null>;
  getPlayerStats(userId: string): Promise<PlayerGameStats>;
  /**
   * At most `limit` of `filter.gameIds` by completed rounds in range, most played first,
   * ties by game id; a game with no such round is left out. Counts rounds with the same
   * scoping as `roundsPlayed` in listGamePerformance. Optional so an overlay that rebinds
   * this port keeps compiling; without it, a caller ranks from listGamePerformance.
   */
  rankGamesByRounds?(filter: GameRoundRankingFilter): Promise<GameRoundCount[]>;
  /** As `rankGamesByRounds`, over every game. Optional; without it, a caller lists the games to rank. */
  rankAllGamesByRounds?(filter: GameRoundTopFilter): Promise<GameRoundCount[]>;
  /**
   * The games ranked per currency (GameCurrencyRanking). Optional so an overlay that rebinds this
   * port keeps compiling; without it the agent's game ranking is unavailable rather than read
   * past the operator's report.
   */
  rankGamesPerCurrency?(filter: GameCurrencyRankingFilter): Promise<GameCurrencyRanking>;
  /** The providers ranked per currency (ProviderCurrencyRanking); optional as `rankGamesPerCurrency`. */
  rankProvidersPerCurrency?(
    filter: ProviderCurrencyRankingFilter,
  ): Promise<ProviderCurrencyRanking>;
};

export const ADMIN_GAME_REPORTING: Token<AdminGameReporting> = createToken('ADMIN_GAME_REPORTING');

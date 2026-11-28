import { createToken, type Token } from './token.js';
import type { GameSortDirection, GameType } from '../schemas/game.js';
import type { Granularity } from '../schemas/reporting.js';

export const GAME_PERFORMANCE_SORT_FIELDS = [
  'name',
  'gameType',
  'volume',
  'revenue',
  'uniquePlayers',
  'roundsPlayed',
] as const;
export const UNCLASSIFIED_GAME_TYPE = 'unclassified';

export type GamePerformanceSortBy = (typeof GAME_PERFORMANCE_SORT_FIELDS)[number];

export type GamePerformanceFilter = {
  dateFrom?: Date;
  dateTo?: Date;
  gameType?: GameType;
  gameIds?: readonly string[];
  currency?: string;
  sortBy?: GamePerformanceSortBy;
  sortDir?: 'asc' | 'desc';
};

export type GamePerformanceRow = {
  gameId: string;
  name: string;
  gameType: GameType | typeof UNCLASSIFIED_GAME_TYPE;
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

export type GamePerformanceTrendPoint = {
  bucket: string;
  volume: string;
  revenue: string;
  roundsPlayed: number;
};

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
  gameIds: readonly string[];
  limit: number;
};

export type GameRoundTopFilter = Omit<GameRoundRankingFilter, 'gameIds'>;

export type GameRoundCount = {
  gameId: string;
  roundsPlayed: number;
};

export type GameRankingSortBy = Exclude<GamePerformanceSortBy, 'name' | 'gameType'>;

export type GameCurrencyRankingFilter = {
  dateFrom: Date;
  dateTo: Date;
  currency?: string;
  gameType?: GameType;
  sortBy: GameRankingSortBy;
  sortDir: GameSortDirection;
  limit: number;
  maxCurrencies: number;
};

export type GameRankingFigures = {
  volume: string;
  revenue: string;
  roundsPlayed: number;
  uniquePlayers: number;
};

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

export type ProviderRankingSortBy = GameRankingSortBy | 'gamesPlayed';

export type ProviderCurrencyRankingFilter = Omit<GameCurrencyRankingFilter, 'sortBy' | 'limit'> & {
  sortBy: ProviderRankingSortBy;
  limit: number;
};

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
  getGamePerformanceTrend(filter: GamePerformanceTrendFilter): Promise<GamePerformanceTrend | null>;
  getPlayerStats(userId: string): Promise<PlayerGameStats>;
  rankGamesByRounds?(filter: GameRoundRankingFilter): Promise<GameRoundCount[]>;
  rankAllGamesByRounds?(filter: GameRoundTopFilter): Promise<GameRoundCount[]>;
  rankGamesPerCurrency?(filter: GameCurrencyRankingFilter): Promise<GameCurrencyRanking>;
  rankProvidersPerCurrency?(
    filter: ProviderCurrencyRankingFilter,
  ): Promise<ProviderCurrencyRanking>;
};

export const ADMIN_GAME_REPORTING: Token<AdminGameReporting> = createToken('ADMIN_GAME_REPORTING');

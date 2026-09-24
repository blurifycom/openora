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

export type PlayerGameStats = {
  totalWagered: string;
  totalBets: number;
};

export type AdminGameReporting = {
  listGamePerformance(filter: GamePerformanceFilter): Promise<GamePerformanceRow[]>;
  /** `null` when no game has `filter.gameId`. */
  getGamePerformanceTrend(filter: GamePerformanceTrendFilter): Promise<GamePerformanceTrend | null>;
  getPlayerStats(userId: string): Promise<PlayerGameStats>;
};

export const ADMIN_GAME_REPORTING: Token<AdminGameReporting> = createToken('ADMIN_GAME_REPORTING');

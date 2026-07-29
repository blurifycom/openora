import { createToken, type Token } from './token.js';

// Admin/back-office reporting over player registration + engagement activity.
// Owned + bound by iam (see iam/AGENTS.md for why - it centralizes admin reporting
// concerns even though the underlying `user`/`session` tables belong to identity,
// read via that module's read-only /schema subpath); the back-office depends only
// on this port. A query port like ADMIN_WALLET_REPORTING/ADMIN_GAME_REPORTING.
// See ADR-0017/0025.

export type PlayerActivityFilter = {
  dateFrom?: Date;
  dateTo?: Date;
};

// One point per day (UTC, `YYYY-MM-DD`) within the requested range.
export type RegistrationsOverTimePoint = {
  date: string;
  registrations: number;
};

// DAU/WAU/MAU for the trailing 1/7/30-day window ending on `date` (inclusive).
export type ActiveUsersTrendPoint = {
  date: string;
  dau: number;
  wau: number;
  mau: number;
};

// One row per registration-day cohort (UTC day `user.createdAt` truncates to).
// `returnRate` = returned / cohortSize (0 when cohortSize is 0). `isComplete` is
// false while the cohort's [registration, registration + windowDays] window has
// not fully elapsed yet - such a row's low/zero rate is not yet meaningful and
// must be flagged rather than read as real churn.
export type RetentionCohortRow = {
  cohortDate: string;
  cohortSize: number;
  returned: number;
  returnRate: number;
  isComplete: boolean;
};

export type AdminPlayerActivity = {
  getRegistrationsOverTime(filter: PlayerActivityFilter): Promise<RegistrationsOverTimePoint[]>;
  getActiveUsersTrend(filter: PlayerActivityFilter): Promise<ActiveUsersTrendPoint[]>;
  // windowDays is always 7 or 30 (the two cohorts the ticket asks for); a plain
  // number keeps the port from hard-coding a union it would need to duplicate again
  // the moment a third window is added.
  getRetentionCohorts(
    filter: PlayerActivityFilter,
    windowDays: 7 | 30,
  ): Promise<RetentionCohortRow[]>;
};

export const ADMIN_PLAYER_ACTIVITY: Token<AdminPlayerActivity> =
  createToken('ADMIN_PLAYER_ACTIVITY');

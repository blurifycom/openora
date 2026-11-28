import { createToken, type Token } from './token.js';

export type PlayerActivityFilter = {
  dateFrom?: Date;
  dateTo?: Date;
};

export type RegistrationsOverTimePoint = {
  date: string;
  registrations: number;
};

export type ActiveUsersTrendPoint = {
  date: string;
  dau: number;
  wau: number;
  mau: number;
};

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
  getRetentionCohorts(
    filter: PlayerActivityFilter,
    windowDays: 7 | 30,
  ): Promise<RetentionCohortRow[]>;
};

export const ADMIN_PLAYER_ACTIVITY: Token<AdminPlayerActivity> =
  createToken('ADMIN_PLAYER_ACTIVITY');

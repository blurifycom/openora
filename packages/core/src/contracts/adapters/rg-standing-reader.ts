import type {
  ExclusionKind,
  LimitChangeKind,
  LimitPeriod,
  LimitType,
  RgFlagType,
} from '../schemas/compliance.js';
import type { User } from '../schemas/identity.js';
import { createToken, type Token } from './token.js';

export const MAX_RG_STANDING_WINDOWS = 4;

export const MAX_RG_STANDING_WINDOW_DAYS = 365;

export type RgStandingExclusion = {
  kind: ExclusionKind;
  startsAt: Date;
  expiresAt: Date | null;
  isPermanent: boolean;
};

export type RgStandingFlag = {
  flagType: RgFlagType;
  limitType: LimitType | null;
  flaggedAt: Date;
};

type RgStandingLimitChange = {
  pendingKind: LimitChangeKind | null;
  pendingRequestedAt: Date | null;
};

export type RgStandingLimit = (
  | {
      type: Exclude<LimitType, 'session'>;
      period: LimitPeriod;
      amount: string;
      currency: string;
    }
  | { type: 'session'; period: LimitPeriod; minutes: number }
) &
  RgStandingLimitChange;

export type RgStandingWindow = {
  days: number;
  totals: { deposits: string; bets: string; wins: string } | null;
};

export type RgStanding = {
  restricted: boolean;
  activeExclusions: RgStandingExclusion[];
  selfExclusionsOnRecord: number;
  lastSelfExclusionEndedAt: Date | null;
  lastCoolingOffEndedAt: Date | null;
  activeFlags: RgStandingFlag[];
  limits: RgStandingLimit[];
  pivotCurrency: string;
  windows: RgStandingWindow[];
};

export type RgStandingQuery = {
  windowDays: readonly number[];
};

export type RgStandingReader = {
  getStanding(userId: User['id'], query: RgStandingQuery): Promise<RgStanding | null>;
};

export const RG_STANDING_READER: Token<RgStandingReader> =
  createToken<RgStandingReader>('RG_STANDING_READER');

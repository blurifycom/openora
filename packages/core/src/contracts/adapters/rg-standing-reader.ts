/**
 * Read-only view of a player's responsible-gambling standing, owned and bound by compliance, for
 * code outside it (an agent's harm check before it proposes a benefit) that must not read
 * compliance tables. It reports facts and draws no conclusion: what counts as harm is the
 * caller's policy. It carries no free-text reason and no admin id.
 *
 * Not an enforcement point: a wager, a deposit and a login are refused by `PLAY_ELIGIBILITY`,
 * `RG_LIMITS` and the login gate, never by a reading of this port. It is not sealed either, so
 * an overlay could rebind it; one that reports less than compliance holds weakens every harm
 * check built on it, so rebind it only to add facts.
 */
import type { ExclusionKind, LimitPeriod, LimitType, RgFlagType } from '../schemas/compliance.js';
import type { User } from '../schemas/identity.js';
import { createToken, type Token } from './token.js';

export const MAX_RG_STANDING_WINDOWS = 4;

export const MAX_RG_STANDING_WINDOW_DAYS = 365;

/** An exclusion in force now: a self-exclusion until it is lifted, a cooling-off until it ends. */
export type RgStandingExclusion = {
  kind: ExclusionKind;
  startsAt: Date;
  /** Null for a permanent self-exclusion. A fixed-term one stays in force past it until lifted. */
  expiresAt: Date | null;
  isPermanent: boolean;
};

export type RgStandingFlag = {
  flagType: RgFlagType;
  /** The limit a threshold flag is about; null for a flag about no limit. */
  limitType: LimitType | null;
  flaggedAt: Date;
};

/** A limit as it applies now; a requested raise or removal still waiting is not shown. */
export type RgStandingLimit =
  | {
      type: Exclude<LimitType, 'session'>;
      period: LimitPeriod;
      amount: string;
      /** A limit set before limits carried a currency is in the player's own currency. */
      currency: string;
    }
  | { type: 'session'; period: LimitPeriod; minutes: number };

/**
 * Completed money movement in the last `days` days, priced into `pivotCurrency`: deposits by
 * when they reached the balance, stakes less the stakes reversed, and wins.
 */
export type RgStandingWindow = {
  days: number;
  /** Null when any amount in the window is in a currency that cannot be priced. Never partial. */
  totals: { deposits: string; bets: string; wins: string } | null;
};

export type RgStanding = {
  /** Whether `PLAY_ELIGIBILITY` refuses the player's wagers now. */
  restricted: boolean;
  activeExclusions: RgStandingExclusion[];
  /** Every self-exclusion the player has had, in force or ended. */
  selfExclusionsOnRecord: number;
  /** When the latest self-exclusion that is no longer in force was lifted or ran out. */
  lastSelfExclusionEndedAt: Date | null;
  /** When the latest cooling-off that is no longer in force was lifted or ran out. */
  lastCoolingOffEndedAt: Date | null;
  activeFlags: RgStandingFlag[];
  limits: RgStandingLimit[];
  pivotCurrency: string;
  /** One per requested window, in the order requested. */
  windows: RgStandingWindow[];
};

export type RgStandingQuery = {
  /**
   * The money windows to total, at most `MAX_RG_STANDING_WINDOWS`, each a whole number of days
   * from 1 to `MAX_RG_STANDING_WINDOW_DAYS`; anything else throws a `RangeError`.
   */
  windowDays: readonly number[];
};

export type RgStandingReader = {
  /** Null when the user has no player profile. */
  getStanding(userId: User['id'], query: RgStandingQuery): Promise<RgStanding | null>;
};

export const RG_STANDING_READER: Token<RgStandingReader> =
  createToken<RgStandingReader>('RG_STANDING_READER');

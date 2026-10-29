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

type RgStandingLimitChange = {
  /**
   * A raise or removal the player asked for that has not applied yet: it waits out the
   * cool-down and then the player's confirmation. Null when none is waiting.
   */
  pendingKind: LimitChangeKind | null;
  /** When the player asked for it; null when none is waiting. */
  pendingRequestedAt: Date | null;
};

/** A limit as it applies now: a raise or removal still waiting never shows in its value. */
export type RgStandingLimit = (
  | {
      type: Exclude<LimitType, 'session'>;
      period: LimitPeriod;
      amount: string;
      /** A limit set before limits carried a currency is in the player's own currency. */
      currency: string;
    }
  | { type: 'session'; period: LimitPeriod; minutes: number }
) &
  RgStandingLimitChange;

/**
 * Completed money movement in the last `days` days, priced into `pivotCurrency` at today's
 * rates: deposits by when they reached the balance, ledger stakes less the stakes reversed, and
 * wins. A stake placed before the window and reversed inside it still comes off, so stakes can
 * read low at the window's edge, never below zero in a currency. These are not the figures a
 * limit is enforced against: `RG_LIMITS` counts each limit over its own period, in its own
 * currency.
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
  /**
   * Null when the user has no player profile. Reads compliance and wallet facts from one
   * snapshot on a connection of its own, so call it outside a transaction: taking a second pool
   * connection while holding the first is how the pool deadlocks under a burst.
   */
  getStanding(userId: User['id'], query: RgStandingQuery): Promise<RgStanding | null>;
};

export const RG_STANDING_READER: Token<RgStandingReader> =
  createToken<RgStandingReader>('RG_STANDING_READER');

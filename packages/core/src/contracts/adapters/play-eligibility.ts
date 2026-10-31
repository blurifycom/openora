import { createToken, type Token } from './token.js';

/**
 * Read port for Responsible-Gambling play enforcement. Owned + bound by the identity
 * module (it owns the `user` table and the `rgBlocked`/`rgBlockedUntil` projection that
 * `LOGIN_ENFORCEMENT` writes). Gaming and wallet depend only on this port to refuse a
 * wager, never on the identity schema.
 *
 * A cooling-off whose `rgBlockedUntil` has elapsed reports `false` without waiting for
 * the expiry sweep, matching the login gate's lazy-expiry behaviour.
 *
 * A caller already inside a transaction passes it as `tx`: a second pool connection taken
 * while the first is held deadlocks once every connection is held by such a caller. The
 * read then holds the player's row `FOR SHARE` until that transaction ends, so a
 * restriction landing concurrently waits for it instead of committing between the check
 * and the money movement it gates.
 */
export type PlayEligibilityPort = {
  isRestricted(userId: string, tx?: unknown): Promise<boolean>;
  /**
   * Why the player may not play now, on top of the RG block `isRestricted` reports: the account's
   * own state too. `null` lets them play. Same `tx` rule as `isRestricted`. Optional: a caller
   * without it falls back to `isRestricted` and cannot name the reason.
   */
  checkPlay?(userId: string, tx?: unknown): Promise<PlayRefusal | null>;
};

export const PLAY_REFUSALS = [
  'self_excluded',
  'cooling_off',
  'account_suspended',
  'account_closed',
  'account_inactive',
] as const;
export type PlayRefusal = (typeof PLAY_REFUSALS)[number];

export const PLAY_ELIGIBILITY: Token<PlayEligibilityPort> =
  createToken<PlayEligibilityPort>('PLAY_ELIGIBILITY');

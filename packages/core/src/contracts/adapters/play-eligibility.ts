import { createToken, type Token } from './token.js';

/**
 * Read port for Responsible-Gambling play enforcement. Owned + bound by the identity
 * module (it owns the `user` table and the `rgBlocked`/`rgBlockedUntil` projection that
 * `LOGIN_ENFORCEMENT` writes). Gaming and wallet depend only on this port to refuse a
 * wager, never on the identity schema.
 *
 * A cooling-off whose `rgBlockedUntil` has elapsed reports `false` without waiting for
 * the expiry sweep, matching the login gate's lazy-expiry behaviour.
 */
export type PlayEligibilityPort = {
  isRestricted(userId: string): Promise<boolean>;
};

export const PLAY_ELIGIBILITY: Token<PlayEligibilityPort> =
  createToken<PlayEligibilityPort>('PLAY_ELIGIBILITY');

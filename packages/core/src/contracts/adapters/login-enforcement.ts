/**
 * Push port for Responsible-Gambling login enforcement. Owned + bound by the identity
 * module (it owns the `user` table); compliance depends only on this port to block or
 * unblock a player's login, never on the identity schema. `block` also revokes all of
 * the player's active sessions (the RG session-termination requirement). `until: null`
 * means an indefinite block (self-exclusion / permanent); a Date is the cooling-off
 * expiry the login gate auto-clears once elapsed. See ADR-0017.
 */
import { createToken, type Token } from './token.js';

export type LoginEnforcementPort = {
  block(userId: string, opts: { until: Date | null }): Promise<void>;
  unblock(userId: string): Promise<void>;
};

export const LOGIN_ENFORCEMENT: Token<LoginEnforcementPort> = createToken('LOGIN_ENFORCEMENT');

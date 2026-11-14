/**
 * Push port for Responsible-Gambling login enforcement. Owned + bound by the identity
 * module (it owns the `user` table); compliance depends only on this port to block or
 * unblock a player's login, never on the identity schema. `block` also revokes all of
 * the player's active sessions (the RG session-termination requirement). `until: null`
 * means an indefinite block (self-exclusion / permanent); a Date is the cooling-off
 * expiry the login gate auto-clears once elapsed. See ADR-0017.
 *
 * Both run on the caller's `tx`, so the block, the ledger's play eligibility and the session
 * revocation commit or roll back with the RG record that caused them.
 */
import { createToken, type Token } from './token.js';

export type LoginEnforcementPort = {
  block(userId: string, opts: { until: Date | null }, tx: unknown): Promise<void>;
  unblock(userId: string, tx: unknown): Promise<void>;
};

export const LOGIN_ENFORCEMENT: Token<LoginEnforcementPort> = createToken('LOGIN_ENFORCEMENT');

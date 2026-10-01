/**
 * Pull port for "this account must set up a second factor before it does anything else".
 * Bound by the identity module (it owns the `user` table); the request middleware depends
 * only on this port and never on the identity schema (ADR-0019/0025).
 *
 * `isSetupRequired` answers true while an account requires a second factor on login but
 * has none enrolled - the state a support reset of a player's 2FA leaves behind. The
 * middleware then marks the request so `getUserId` refuses it; identity's own routes read
 * the session themselves, which is what keeps the enrolment flow reachable.
 */
import { createToken, type Token } from './token.js';

export type TwoFactorSetupPolicy = {
  isSetupRequired(userId: string): Promise<boolean>;
};

export const TWO_FACTOR_SETUP_POLICY: Token<TwoFactorSetupPolicy> =
  createToken('TWO_FACTOR_SETUP_POLICY');

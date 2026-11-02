/**
 * Seam letting the wallet ask the identity module the two security questions a payout raises,
 * without importing the identity schema (module isolation). Bound by identity, which owns the
 * `user` table, the PIN hash and the password/second-factor check.
 *
 * `verifyPin` never throws on a wrong or missing PIN: the wallet turns each outcome into its own
 * error, so the money path decides what a refusal looks like. `locked` answers even a correct
 * PIN, because a lock that a right guess could lift would not slow a brute-force down.
 */
import { createToken, type Token } from './token.js';
import type { ClientMeta } from '../schemas/common.js';

export type WithdrawalPinVerdict =
  /** No PIN is set, so there is nothing to ask. */
  | { status: 'not_set' }
  | { status: 'ok' }
  | { status: 'missing' }
  | { status: 'incorrect'; attemptsLeft: number }
  | { status: 'locked'; lockedUntil: Date };

export type WithdrawalSecurity = {
  /**
   * Checks the PIN a withdrawal carries. A wrong PIN counts toward the lockout; the fifth in a
   * row locks withdrawals and mails the player. A correct PIN resets the count.
   */
  verifyPin(input: {
    userId: string;
    pin: string | undefined;
    meta?: Partial<ClientMeta>;
  }): Promise<WithdrawalPinVerdict>;

  /**
   * The password, plus a fresh second-factor code when the account has one, for an action that
   * must be the account owner and not a stolen session. Throws the same errors as setting the PIN.
   */
  assertReauthentication(input: {
    userId: string;
    headers: Record<string, string | string[] | undefined>;
    currentPassword: string;
    totpCode: string | undefined;
    meta: ClientMeta;
  }): Promise<void>;
};

export const WITHDRAWAL_SECURITY: Token<WithdrawalSecurity> = createToken('WITHDRAWAL_SECURITY');

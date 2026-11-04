/**
 * Seam letting a module outside identity demand proof that the account owner, and not only a
 * live session, is behind a request: the standing password, plus a fresh second-factor code
 * when the account has one enrolled. Bound by identity, which owns the credential and the
 * second-factor lockout.
 *
 * `assert` never throws on an expected refusal: the caller turns each verdict into its own
 * error. `locked` answers whatever the password, so a locked account is no password oracle. A
 * wrong code counts toward the second-factor lockout like every other re-authenticated flow,
 * and a right one resets it.
 */
import { createToken, type Token } from './token.js';
import type { ClientMeta } from '../schemas/common.js';
import type { User } from '../schemas/identity.js';

export type FreshReauthenticationVerdict =
  | { status: 'ok' }
  | { status: 'password_invalid' }
  /** The account has a second factor enrolled and no code came with the request. */
  | { status: 'second_factor_required' }
  | { status: 'second_factor_invalid'; attemptsLeft?: number }
  | { status: 'locked'; lockedUntil: Date };

export type FreshReauthentication = {
  assert(input: {
    userId: User['id'];
    /** The request's own headers: a second-factor check runs against the caller's session. */
    headers: Record<string, string | string[] | undefined>;
    currentPassword: string;
    totpCode: string | undefined;
    meta: ClientMeta;
  }): Promise<FreshReauthenticationVerdict>;
};

export const FRESH_REAUTHENTICATION: Token<FreshReauthentication> =
  createToken('FRESH_REAUTHENTICATION');

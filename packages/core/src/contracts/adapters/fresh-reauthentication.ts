import { createToken, type Token } from './token.js';
import type { ClientMeta } from '../schemas/common.js';
import type { User } from '../schemas/identity.js';

export type FreshReauthenticationVerdict =
  | { status: 'ok' }
  | { status: 'password_invalid' }
  | { status: 'second_factor_required' }
  | { status: 'second_factor_invalid'; attemptsLeft?: number }
  | { status: 'locked'; lockedUntil: Date };

export type FreshReauthentication = {
  assert(input: {
    userId: User['id'];
    headers: Record<string, string | string[] | undefined>;
    currentPassword: string;
    totpCode: string | undefined;
    meta: ClientMeta;
  }): Promise<FreshReauthenticationVerdict>;
};

export const FRESH_REAUTHENTICATION: Token<FreshReauthentication> =
  createToken('FRESH_REAUTHENTICATION');

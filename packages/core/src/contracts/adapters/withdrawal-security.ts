import { createToken, type Token } from './token.js';
import type { ClientMeta } from '../schemas/common.js';

export type WithdrawalPinVerdict =
  | { status: 'not_set' }
  | { status: 'ok' }
  | { status: 'missing' }
  | { status: 'incorrect'; attemptsLeft: number }
  | { status: 'locked'; lockedUntil: Date };

export type WithdrawalSecurity = {
  verifyPin(input: {
    userId: string;
    pin: string | undefined;
    meta?: Partial<ClientMeta>;
  }): Promise<WithdrawalPinVerdict>;

  pinLockedUntil(userId: string): Promise<Date | null>;

  assertReauthentication(input: {
    userId: string;
    headers: Record<string, string | string[] | undefined>;
    currentPassword: string;
    totpCode: string | undefined;
    meta: ClientMeta;
  }): Promise<void>;
};

export const WITHDRAWAL_SECURITY: Token<WithdrawalSecurity> = createToken('WITHDRAWAL_SECURITY');

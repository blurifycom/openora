import { createToken, type Token } from './token.js';

export type DepositHoldPolicy = {
  holdReason(
    tx: unknown,
    deposit: { userId: string; amount: string; currency: string },
  ): Promise<string | null>;
};

export const DEPOSIT_HOLD_POLICY: Token<DepositHoldPolicy> =
  createToken<DepositHoldPolicy>('DEPOSIT_HOLD_POLICY');

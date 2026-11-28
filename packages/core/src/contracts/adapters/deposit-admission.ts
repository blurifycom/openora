import { createToken, type Token } from './token.js';

export type DepositAdmissionPolicy = {
  refusalReason(userId: string): Promise<string | null>;
};

export const DEPOSIT_ADMISSION_POLICY: Token<DepositAdmissionPolicy> =
  createToken<DepositAdmissionPolicy>('DEPOSIT_ADMISSION_POLICY');

export class DepositRefusedError extends Error {
  readonly data: { reason: string };

  constructor(reason: string) {
    super(`deposit refused: ${reason}`);
    this.name = 'DepositRefusedError';
    this.data = { reason };
  }
}

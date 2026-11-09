import { createToken, type Token } from './token.js';

/**
 * Decides whether a player may start a deposit: asked before a PSP deposit, before a deposit
 * address is handed out (also one issued earlier) and before an on-ramp checkout opens. Returns the refusal
 * reason, or `null` to admit. It cannot stop funds already sent on chain - that is
 * `DEPOSIT_HOLD_POLICY`.
 *
 * Optional (`c.has`); unbound, every player `PLAY_ELIGIBILITY` admits may deposit.
 */
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

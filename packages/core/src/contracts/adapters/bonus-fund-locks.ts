import type { ClientMeta } from '../schemas/common.js';
import { createSealedToken, type SealedToken } from './token.js';

export type FundOutflow = 'withdrawal' | 'swap' | 'transfer';

export type LockedFunds = { locked: string; free: string };

export type LockedFundsArgs = { userId: string; currency: string; realBalance: string };

export type ReadLockedFundsArgs = {
  userId: string;
  balances: readonly { currency: string; realBalance: string }[];
};

type OutflowAmount = {
  userId: string;
  currency: string;
  amount: string;
  balanceAfter: string;
};

export type BonusOutflowArgs =
  | (OutflowAmount & {
      outflow: 'withdrawal';
      actor: { id: string; isAdmin: boolean };
      note: string;
      meta?: ClientMeta | undefined;
    })
  | (OutflowAmount & { outflow: Exclude<FundOutflow, 'withdrawal'> });

export type BonusFundsLockedData = {
  reason: 'bonus_funds_locked';
  outflow: FundOutflow;
  currency: string;
  locked: string;
  free: string;
};

export class BonusFundsLockedError extends Error {
  readonly data: BonusFundsLockedData;

  constructor(message: string, data: Omit<BonusFundsLockedData, 'reason'>) {
    super(message);
    this.name = 'BonusFundsLockedError';
    this.data = { reason: 'bonus_funds_locked', ...data };
  }
}

export type BonusFundLockCommands = {
  lockedFunds(tx: unknown, args: LockedFundsArgs): Promise<LockedFunds>;
  readLockedFunds(db: unknown, args: ReadLockedFundsArgs): Promise<LockedFunds[]>;
  onOutflow(tx: unknown, args: BonusOutflowArgs): Promise<void>;
};

export const BONUS_FUND_LOCKS: SealedToken<BonusFundLockCommands> =
  createSealedToken('bonus-fund-locks');

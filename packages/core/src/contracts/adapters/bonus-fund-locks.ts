/**
 * Bonus fund lock port: real money a locking bonus grant ties up (its buckets A and B) may not
 * leave its currency by withdrawal, swap or transfer to another player. The wallet calls it on its
 * own transaction, after the debit, so a refusal rolls the whole movement back. ADR-0064.
 */
import type { ClientMeta } from '../schemas/common.js';
import { createSealedToken, type SealedToken } from './token.js';

export type FundOutflow = 'withdrawal' | 'swap' | 'transfer';

export type LockedFunds = { locked: string; free: string };

export type LockedFundsArgs = { userId: string; currency: string; realBalance: string };

type OutflowAmount = {
  userId: string;
  currency: string;
  amount: string;
  /** Real balance in `currency` after the caller's debit of `amount`. */
  balanceAfter: string;
};

export type BonusOutflowArgs =
  | (OutflowAmount & {
      outflow: 'withdrawal';
      /** Recorded on a forfeit the withdrawal causes. */
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

/** The outflow would take real money a locking bonus grant ties up. The router answers CONFLICT. */
export class BonusFundsLockedError extends Error {
  readonly data: BonusFundsLockedData;

  constructor(message: string, data: Omit<BonusFundsLockedData, 'reason'>) {
    super(message);
    this.name = 'BonusFundsLockedError';
    this.data = { reason: 'bonus_funds_locked', ...data };
  }
}

export type BonusFundLockCommands = {
  /**
   * What of `realBalance` the player's locking grants in `currency` tie up. The caller already
   * holds the wallet row and that currency's balance row locks; this adds the grants' FOR SHARE.
   */
  lockedFunds(tx: unknown, args: LockedFundsArgs): Promise<LockedFunds>;
  /**
   * In `forfeit` mode a withdrawal forfeits every live grant, in every currency, announcing each
   * `promo.bonus.forfeited` on `tx`. Otherwise throws `BonusFundsLockedError` when `balanceAfter`
   * is below what was locked before the debit.
   */
  onOutflow(tx: unknown, args: BonusOutflowArgs): Promise<void>;
};

export const BONUS_FUND_LOCKS: SealedToken<BonusFundLockCommands> =
  createSealedToken('bonus-fund-locks');

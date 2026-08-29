import { createToken } from './token.js';

/** One player balance row, as returned by `WalletReader.getBalances`. */
export type WalletBalanceReading = {
  currency: string;
  balance: string;
};

/** Full per-currency balance snapshot for a player, as returned by `WalletReader.getBalances`. */
export type WalletBalancesReading = {
  activeCurrency: string;
  balances: WalletBalanceReading[];
};

export type WalletReader = {
  /** Sum of all completed deposits for a player, as a decimal string (same as wallet_transaction.amount). Used for high_roller evaluation. */
  getLifetimeDeposit(userId: string): Promise<string>;
  /**
   * Every currency balance the player holds plus their active/operating wallet
   * currency. Always answers - a player with no wallet row yet gets an empty
   * `balances` array and the platform's default wallet currency, never a throw.
   * Used by the display-currency resolver (pam/profile) to find which currency a
   * player holds the most value in when they have not picked a display currency.
   */
  getBalances(userId: string): Promise<WalletBalancesReading>;
  /** Count of completed withdrawals for a player within the last windowDays days. Used for high_risk evaluation. */
  getWithdrawalCountInWindow(userId: string, windowDays: number): Promise<number>;
  /**
   * Completed-withdrawal counts within the last windowDays days for a batch of players,
   * keyed by userId (absent key = 0). Used for the high_risk daily resweep. Optional so an
   * external/consumer WalletReader implementation that predates this batched method still
   * satisfies the port - a caller without it falls back to looping the singular
   * getWithdrawalCountInWindow (see TagEvaluationService's high_risk resweep).
   */
  getWithdrawalCountsInWindow?(userIds: string[], windowDays: number): Promise<Map<string, number>>;
};

export const WALLET_READER = createToken<WalletReader>('WALLET_READER');

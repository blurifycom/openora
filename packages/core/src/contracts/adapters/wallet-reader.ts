import { createToken } from './token.js';

export type WalletReader = {
  /** Sum of all completed deposits for a player, as a decimal string (same as wallet_transaction.amount). Used for high_roller evaluation. */
  getLifetimeDeposit(userId: string): Promise<string>;
  /** Count of completed withdrawals for a player within the last windowDays days. Used for high_risk evaluation. */
  getWithdrawalCountInWindow(userId: string, windowDays: number): Promise<number>;
  /** Completed-withdrawal counts within the last windowDays days for a batch of players, keyed by userId (absent key = 0). Used for the high_risk daily resweep. */
  getWithdrawalCountsInWindow(userIds: string[], windowDays: number): Promise<Map<string, number>>;
};

export const WALLET_READER = createToken<WalletReader>('WALLET_READER');

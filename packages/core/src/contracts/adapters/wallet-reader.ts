import { createToken } from './token.js';

export type WalletReader = {
  /** Sum of all completed deposits for a player in the wallet's decimal unit (same as wallet_transaction.amount). Used for high_roller evaluation. */
  getLifetimeDeposit(userId: string): Promise<number>;
  /** Count of completed withdrawals for a player within the last windowDays days. Used for high_risk evaluation. */
  getWithdrawalCountInWindow(userId: string, windowDays: number): Promise<number>;
};

export const WALLET_READER = createToken<WalletReader>('WALLET_READER');

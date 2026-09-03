import { createToken } from './token.js';
import type { WalletTransactionType, WalletTransactionStatus } from '../schemas/wallet-tx.js';

export type WalletProviderTransaction = {
  id: string;
  type: WalletTransactionType;
  amount: string;
  currency: string;
  status: WalletTransactionStatus;
  providerName: string;
  providerRefId: string;
  externalRoundId: string | null;
  /** Raw JSON string from wallet_transaction.metadata - caller parses it. Present when the
   *  original debit/credit included a responseSnapshot (see WalletCommands below). */
  metadata: string | null;
  createdAt: Date;
};

export type WalletReader = {
  /** Sum of all completed deposits for a player, as a decimal string (same as wallet_transaction.amount). Used for high_roller evaluation. */
  getLifetimeDeposit(userId: string): Promise<string>;
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
  /**
   * Looks up the wallet_transaction row tagged with this exact (providerName,
   * providerRefId) pair, if any. Lets a caller replaying a provider callback return the
   * original response deterministically instead of reconstructing one from current
   * state. Optional for the same reason as getWithdrawalCountsInWindow above - a
   * pre-existing external WalletReader implementation still satisfies the port.
   */
  findByProviderRef?(
    providerName: string,
    providerRefId: string,
  ): Promise<WalletProviderTransaction | null>;
  /**
   * Current balance in the player's active wallet currency. Optional for the same
   * reason as getWithdrawalCountsInWindow above - a pre-existing external WalletReader
   * implementation still satisfies the port.
   */
  getBalance?(userId: string): Promise<{ balance: string; currency: string }>;
};

export const WALLET_READER = createToken<WalletReader>('WALLET_READER');

import { createToken } from './token.js';
import type { WalletTransactionType, WalletTransactionStatus } from '../schemas/wallet-tx.js';

export type WalletProviderTransaction = {
  id: string;
  walletId: string;
  userId: string;
  type: WalletTransactionType;
  amount: string;
  currency: string;
  status: WalletTransactionStatus;
  providerName: string;
  providerRefId: string;
  externalRoundId: string | null;
  metadata: string | null;
  createdAt: Date;
};

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
  /**
   * Sum of all completed deposits for a player, priced into the implementation's reference
   * currency (a decimal string, not necessarily the same unit as wallet_transaction.amount -
   * a player can deposit in several currencies). Null when at least one currency's amount
   * could not be priced; never a partial or fabricated total. Used for high_roller evaluation.
   */
  getLifetimeDeposit(userId: string): Promise<string | null>;
  /** Always answers: a player with no wallet row yet gets an empty `balances` array and the platform's default wallet currency, never a throw. */
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
  /** Looks up the wallet_transaction row tagged with this (providerName, providerRefId) pair, if any. Optional for the same reason as getWithdrawalCountsInWindow above. */
  findByProviderRef?(
    providerName: string,
    providerRefId: string,
  ): Promise<WalletProviderTransaction | null>;
  /** Current balance in the player's active wallet currency. Optional for the same reason as getWithdrawalCountsInWindow above. */
  getBalance?(userId: string): Promise<{ balance: string; currency: string }>;
  /**
   * Whether this completed deposit transaction is the earliest completed deposit this player
   * has ever made, decided from each deposit's own committed `created_at` rather than a live sum.
   * A first-deposit-only bonus is awarded from an at-least-once job that can run for an earlier
   * deposit after a later one already settled; comparing the running lifetime total to the
   * deposit's own amount at that point answers a question that has already moved on. Optional
   * for the same reason as getWithdrawalCountsInWindow above - a caller without it falls back to
   * the lifetime-total comparison.
   */
  isFirstDeposit?(userId: string, transactionId: string): Promise<boolean>;
};

export const WALLET_READER = createToken<WalletReader>('WALLET_READER');

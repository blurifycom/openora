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

/**
 * A player's withdrawals, priced into `pivotCurrency`. Each total is null when one of its
 * currencies could not be priced, never a partial sum.
 */
export type WalletLifetimeWithdrawals = {
  /**
   * Paid out, counted as debited from the balance: the network fee kept from a withdrawal is in
   * it, so it is more than reached the player.
   */
  completed: string | null;
  /** Requested, held for review or sent to the vendor, and not settled yet. */
  open: string | null;
  pivotCurrency: string;
};

/** A player's most recent completed deposit, as returned by `WalletReader.getLastDeposit`. */
export type WalletLastDeposit = {
  transactionId: string;
  /** When it reached the balance: a held deposit counts from its release, not its arrival. */
  at: Date;
  amount: string;
  currency: string;
  /** `amount` priced into `pivotCurrency`; null when it could not be priced. */
  pivotAmount: string | null;
  pivotCurrency: string;
};

/** The withdrawals a player asked for, as the auto-approval velocity check counts them. */
export type WalletWithdrawalRequests = {
  count: number;
  /** Their total, priced into `pivotCurrency`; null when it could not be priced. */
  pivotAmount: string | null;
  pivotCurrency: string;
};

/**
 * A player's money as the wallet holds it, for modules that must not read its tables. A total
 * across currencies is priced into the reader's reference currency, the fx pivot, at today's
 * rates rather than the rate on the day the money moved. A method without a `tx` parameter reads
 * on a pool connection of its own, so call it outside a transaction: taking a second connection
 * while holding the first is how the pool deadlocks under a burst.
 */
export type WalletReader = {
  /**
   * Sum of all completed deposits for a player, priced into the implementation's reference
   * currency (a decimal string, not necessarily the same unit as wallet_transaction.amount -
   * a player can deposit in several currencies). Null when at least one currency's amount
   * could not be priced; never a partial or fabricated total. Used for high_roller evaluation.
   */
  getLifetimeDeposit(userId: string, tx?: unknown): Promise<string | null>;
  /** Always answers: a player with no wallet row yet gets an empty `balances` array and the platform's default wallet currency, never a throw. */
  getBalances(userId: string, tx?: unknown): Promise<WalletBalancesReading>;
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
  /** This player's own wallet_transaction row with a provider reference; null for another player's row or one without. Optional for the same reason as getWithdrawalCountsInWindow above. */
  findOwnProviderTransaction?(
    userId: string,
    transactionId: string,
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
  isFirstDeposit?(userId: string, transactionId: string, tx?: unknown): Promise<boolean>;
  /**
   * The player's completed and still-open withdrawals since the account opened. Optional for
   * the same reason as getWithdrawalCountsInWindow above.
   */
  getLifetimeWithdrawals?(userId: string): Promise<WalletLifetimeWithdrawals>;
  /** Null for a player who never completed a deposit. Optional for the same reason as above. */
  getLastDeposit?(userId: string): Promise<WalletLastDeposit | null>;
  /**
   * When each given player's most recent completed deposit reached the balance, keyed by
   * userId; a player who never completed one is absent. Optional for the same reason as above -
   * a caller without it cannot tell who deposited recently and skips that work.
   */
  getLastDepositAts?(userIds: readonly string[]): Promise<Map<string, Date>>;
  /**
   * Completed stakes since `since`, less the stakes reversed since then, priced into the
   * reader's reference currency. A stake placed before `since` and reversed after it still comes
   * off, so the total can read low at that edge; a currency's total never goes below zero. Null
   * when a currency could not be priced. Optional for the same reason as above.
   */
  getTurnoverSince?(userId: string, since: Date): Promise<string | null>;
  /**
   * The withdrawals requested since `since`, whatever became of them, except those that paid
   * nothing out because the vendor failed or the request was cancelled - the requests the
   * auto-approval velocity check counts. Optional for the same reason as above.
   */
  getWithdrawalRequestsSince?(userId: string, since: Date): Promise<WalletWithdrawalRequests>;
};

export const WALLET_READER = createToken<WalletReader>('WALLET_READER');

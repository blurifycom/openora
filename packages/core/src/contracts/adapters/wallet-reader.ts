import { createToken } from './token.js';
import type { WalletTransactionType, WalletTransactionStatus } from '../schemas/wallet-tx.js';
import type { TurnoverSummary } from './turnover.js';

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

export type WalletBalanceReading = {
  currency: string;
  balance: string;
};

export type WalletBalancesReading = {
  activeCurrency: string;
  balances: WalletBalanceReading[];
};

export type WalletLifetimeWithdrawals = {
  completed: string | null;
  open: string | null;
  pivotCurrency: string;
};

export type WalletLastDeposit = {
  transactionId: string;
  at: Date;
  amount: string;
  currency: string;
  pivotAmount: string | null;
  pivotCurrency: string;
};

export type WalletWithdrawalRequests = {
  count: number;
  pivotAmount: string | null;
  pivotCurrency: string;
};

export type WalletCurrencyTotal = {
  currency: string;
  total: string;
};

export type WalletWindowMetric = 'deposits' | 'bets' | 'wins';

export type WalletWindowTotals = {
  metric: WalletWindowMetric;
  currency: string;
  totals: string[];
};

export type WalletProviderTransactionQuery = {
  providerName: string;
  externalRoundId: string;
  type: WalletTransactionType;
  providerRefSuffix: string;
};

export type WalletReader = {
  getLifetimeDeposit(userId: string, tx?: unknown): Promise<string | null>;
  getBalances(userId: string, tx?: unknown): Promise<WalletBalancesReading>;
  getWithdrawalCountInWindow(userId: string, windowDays: number): Promise<number>;
  getWithdrawalCountsInWindow?(userIds: string[], windowDays: number): Promise<Map<string, number>>;
  findByProviderRef?(
    providerName: string,
    providerRefId: string,
  ): Promise<WalletProviderTransaction | null>;
  findOwnProviderTransaction?(
    userId: string,
    transactionId: string,
  ): Promise<WalletProviderTransaction | null>;
  getBalance?(userId: string): Promise<{ balance: string; currency: string }>;
  isFirstDeposit?(userId: string, transactionId: string, tx?: unknown): Promise<boolean>;
  hasQualifyingDeposit?(
    userId: string,
    args: { currency: string; minAmount: string; before?: string },
    tx?: unknown,
  ): Promise<boolean>;
  getLifetimeWithdrawals?(userId: string): Promise<WalletLifetimeWithdrawals>;
  getLastDeposit?(userId: string): Promise<WalletLastDeposit | null>;
  getLastDepositAts?(userIds: readonly string[]): Promise<Map<string, Date>>;
  getTurnoverSince?(userId: string, since: Date): Promise<string | null>;
  readTurnover?(userId: string, tx?: unknown): Promise<TurnoverSummary>;
  getWithdrawalRequestsSince?(userId: string, since: Date): Promise<WalletWithdrawalRequests>;
  getDepositsByCurrency(userId: string, tx?: unknown): Promise<WalletCurrencyTotal[]>;
  getMoneyByWindow(
    userId: string,
    windowStarts: readonly Date[],
    tx?: unknown,
  ): Promise<WalletWindowTotals[]>;
  hasWallet(userId: string, tx: unknown): Promise<boolean>;
  sumProviderTransactions(query: WalletProviderTransactionQuery, tx: unknown): Promise<string>;
};

export const WALLET_READER = createToken<WalletReader>('WALLET_READER');

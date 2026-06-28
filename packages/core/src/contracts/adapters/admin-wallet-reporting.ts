import { createToken, type Token } from './token.js';
import type {
  WalletRail,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../schemas/wallet-tx.js';

// Admin/back-office reporting over wallet money movement. Owned + bound by the
// wallet module; the back-office depends only on this port, never on the wallet
// schema. A query port like WALLET_COMMANDS. See ADR-0017/0025.

export type AdminTxRow = {
  id: string;
  userId: string;
  type: WalletTransactionType;
  amount: number;
  currency: string;
  status: WalletTransactionStatus;
  rail: WalletRail | null;
  createdAt: Date;
};

export type AdminTxDetail = AdminTxRow & {
  providerRefId: string | null;
  providerName: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewReason: string | null;
};

export type AdminTxListOptions = {
  page: number;
  limit: number;
  userIds?: string[];
  type?: WalletTransactionType;
  currency?: string;
  rail?: WalletRail;
  status?: WalletTransactionStatus;
  dateFrom?: Date;
  dateTo?: Date;
  amountMin?: number;
  amountMax?: number;
};

export type AdminWalletReporting = {
  totals(): Promise<{ deposits: number; withdrawals: number }>;
  listTransactions(opts: AdminTxListOptions): Promise<{ rows: AdminTxRow[]; total: number }>;
  getTransaction(id: string): Promise<AdminTxDetail | null>;
};

export const ADMIN_WALLET_REPORTING: Token<AdminWalletReporting> =
  createToken('ADMIN_WALLET_REPORTING');

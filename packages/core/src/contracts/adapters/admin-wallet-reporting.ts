import { createToken, type Token } from './token.js';
import type {
  WalletRail,
  WalletTransactionStatus,
  WalletTransactionType,
} from '../schemas/wallet-tx.js';
import type { SortOrder } from '../kit.js';

export type AdminTxRow = {
  id: string;
  userId: string;
  type: WalletTransactionType;
  amount: string;
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

export const ADMIN_TX_SORT_BY_VALUES = [
  'createdAt',
  'amount',
  'type',
  'status',
  'currency',
  'rail',
  'reviewedAt',
] as const;
export type AdminTxSortBy = (typeof ADMIN_TX_SORT_BY_VALUES)[number];

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
  amountMin?: string;
  amountMax?: string;
  search?: string;
  sortBy?: AdminTxSortBy;
  sortOrder?: SortOrder;
};

export type AdminWalletReporting = {
  totals(): Promise<{ deposits: string; withdrawals: string }>;
  listTransactions(opts: AdminTxListOptions): Promise<{ rows: AdminTxRow[]; total: number }>;
  getTransaction(id: string): Promise<AdminTxDetail | null>;
};

export const ADMIN_WALLET_REPORTING: Token<AdminWalletReporting> =
  createToken('ADMIN_WALLET_REPORTING');

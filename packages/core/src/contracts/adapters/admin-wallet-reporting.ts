import { createToken, type Token } from './token.js';

// Admin/back-office reporting over wallet money movement. Owned + bound by the
// wallet module; the back-office depends only on this port, never on the wallet
// schema. A query port like WALLET_COMMANDS. See ADR-0017/0025.

export type AdminTxRow = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: Date;
};

export type AdminTxListOptions = { page: number; limit: number; userId?: string };

export type AdminWalletReporting = {
  totals(): Promise<{ deposits: number; withdrawals: number }>;
  listTransactions(opts: AdminTxListOptions): Promise<{ rows: AdminTxRow[]; total: number }>;
};

export const ADMIN_WALLET_REPORTING: Token<AdminWalletReporting> =
  createToken('ADMIN_WALLET_REPORTING');

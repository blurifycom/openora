import { pgTable, uuid, text, decimal, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import type { WalletRail, WalletTransactionStatus } from '../schemas/index.js';

export const walletTransactionTypeEnum = pgEnum('wallet_transaction_type', [
  'deposit',
  'withdrawal',
  'bet',
  'win',
]);

export const walletTransactionStatusEnum = pgEnum('wallet_transaction_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'rejected',
]);

export const walletRailEnum = pgEnum('wallet_rail', ['fireblocks', 'psp']);

export const wallet = pgTable('wallet', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().unique('wallet_user_id_unique'),
  balance: decimal().notNull().default('0'),
  currency: text().notNull().default('USD'),
  updatedAt: timestamp()
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const walletTransaction = pgTable(
  'wallet_transaction',
  {
    id: uuid().primaryKey().defaultRandom(),
    walletId: uuid()
      .notNull()
      .references(() => wallet.id),
    type: walletTransactionTypeEnum().notNull(),
    amount: decimal().notNull(),
    currency: text().notNull(),
    status: walletTransactionStatusEnum()
      .$type<WalletTransactionStatus>()
      .notNull()
      .default('pending'),
    rail: walletRailEnum().$type<WalletRail>(),
    // Admin user id (cross-module). Bare uuid, no .references - the user table is
    // owned by another domain.
    reviewedBy: uuid(),
    reviewedAt: timestamp(),
    reviewReason: text(),
    metadata: text(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [index('wallet_transaction_wallet_id_idx').on(t.walletId)],
);

export type Wallet = typeof wallet.$inferSelect;
export type WalletTransaction = typeof walletTransaction.$inferSelect;

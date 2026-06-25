import { pgTable, uuid, text, decimal, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';

export const walletTransactionTypeEnum = pgEnum('wallet_transaction_type', [
  'deposit',
  'withdrawal',
  'bet',
  'win',
]);

export const walletTransactionStatusEnum = pgEnum('wallet_transaction_status', [
  'pending',
  'completed',
  'failed',
]);

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
    status: walletTransactionStatusEnum().notNull().default('pending'),
    metadata: text(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [index('wallet_transaction_wallet_id_idx').on(t.walletId)],
);

export type Wallet = typeof wallet.$inferSelect;
export type WalletTransaction = typeof walletTransaction.$inferSelect;

import { pgTable, uuid, text, decimal, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';

export const walletTransactionTypeEnum = pgEnum('WalletTransactionType', [
  'deposit',
  'withdrawal',
  'bet',
  'win',
]);

export const walletTransactionStatusEnum = pgEnum('WalletTransactionStatus', [
  'pending',
  'completed',
  'failed',
]);

export const wallet = pgTable(
  'wallet',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('userId').notNull().unique(),
    tenantId: text('tenantId').notNull(),
    balance: decimal('balance').notNull().default('0'),
    currency: text('currency').notNull().default('USD'),
    updatedAt: timestamp('updatedAt')
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index('wallet_tenantId_idx').on(t.tenantId)],
);

export const walletTransaction = pgTable(
  'wallet_transaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('walletId')
      .notNull()
      .references(() => wallet.id),
    tenantId: text('tenantId').notNull(),
    type: walletTransactionTypeEnum('type').notNull(),
    amount: decimal('amount').notNull(),
    currency: text('currency').notNull(),
    status: walletTransactionStatusEnum('status').notNull().default('pending'),
    metadata: text('metadata'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('wallet_transaction_walletId_idx').on(t.walletId),
    index('wallet_transaction_tenantId_idx').on(t.tenantId),
  ],
);

export type Wallet = typeof wallet.$inferSelect;
export type WalletTransaction = typeof walletTransaction.$inferSelect;

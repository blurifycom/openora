import { pgTable, uuid, text, decimal, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import {
  WALLET_RAILS,
  WALLET_TRANSACTION_STATUSES,
  WALLET_TRANSACTION_TYPES,
  type WalletRail,
  type WalletTransactionStatus,
} from '../../contracts/schemas/wallet-tx.js';

// Enum values derive from the canonical tuples so the DB enum can never drift from
// the contract. Editing the value set is a one-place change in wallet-tx.ts.
export const walletTransactionTypeEnum = pgEnum(
  'wallet_transaction_type',
  WALLET_TRANSACTION_TYPES,
);

export const walletTransactionStatusEnum = pgEnum(
  'wallet_transaction_status',
  WALLET_TRANSACTION_STATUSES,
);

export const walletRailEnum = pgEnum('wallet_rail', WALLET_RAILS);

export const wallet = pgTable('wallet', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().unique('wallet_user_id_unique'),
  balance: decimal().notNull().default('0'),
  currency: text().notNull().default('USD'),
  updatedAt: timestamp({ withTimezone: true })
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
    reviewedAt: timestamp({ withTimezone: true }),
    reviewReason: text(),
    // The concrete settlement provider (eg a PSP name) and its reference id (eg the
    // PSP charge id), as first-class typed columns so they are filterable for
    // reconciliation rather than buried in free-form JSON.
    providerName: text(),
    providerRefId: text(),
    // Reserved escape hatch for genuinely free-form, non-queryable extras. Provider
    // identity now lives in the typed columns above, not here.
    metadata: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_transaction_wallet_id_idx').on(t.walletId),
    index('wallet_transaction_created_at_idx').on(t.createdAt),
    index('wallet_transaction_type_idx').on(t.type),
    index('wallet_transaction_status_idx').on(t.status),
    index('wallet_transaction_rail_idx').on(t.rail),
    index('wallet_transaction_currency_idx').on(t.currency),
    index('wallet_transaction_provider_ref_id_idx').on(t.providerRefId),
  ],
);

export type Wallet = typeof wallet.$inferSelect;
export type WalletTransaction = typeof walletTransaction.$inferSelect;

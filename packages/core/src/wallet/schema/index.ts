import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  decimal,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  WALLET_RAILS,
  WALLET_TRANSACTION_STATUSES,
  WALLET_TRANSACTION_TYPES,
  type WalletRail,
  type WalletTransactionStatus,
} from '@openora/core/contracts';

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
  balance: decimal({ precision: 18, scale: 8 }).notNull().default('0'),
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
    amount: decimal({ precision: 18, scale: 8 }).notNull(),
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
    destinationAddress: text(),
    txHash: text(),
    // Reserved escape hatch for genuinely free-form, non-queryable extras. Provider
    // identity now lives in the typed columns above, not here.
    metadata: text(),
    // Client-supplied dedup key for deposit/withdraw. A wallet is 1:1 with its user, so
    // scoping the unique index on walletId is equivalent to scoping on userId.
    idempotencyKey: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_transaction_wallet_id_idx').on(t.walletId),
    index('wallet_transaction_created_at_idx').on(t.createdAt),
    index('wallet_transaction_type_idx').on(t.type),
    index('wallet_transaction_status_idx').on(t.status),
    index('wallet_transaction_rail_idx').on(t.rail),
    index('wallet_transaction_currency_idx').on(t.currency),
    index('wallet_transaction_tx_hash_idx').on(t.txHash),
    index('wallet_transaction_status_type_created_at_idx').on(t.status, t.type, t.createdAt),
    index('wallet_transaction_wallet_id_type_status_idx').on(t.walletId, t.type, t.status),
    uniqueIndex('wallet_transaction_provider_ref_id_idx')
      .on(t.providerRefId)
      .where(sql`${t.providerRefId} IS NOT NULL`),
    uniqueIndex('wallet_transaction_wallet_id_idempotency_key_idx')
      .on(t.walletId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

// Per-player threshold override (unique userId); overrides the global autoWithdrawal.fiatThreshold.
export const autoWithdrawalRule = pgTable('auto_withdrawal_rule', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().unique('auto_withdrawal_rule_user_id_unique'),
  threshold: decimal({ precision: 18, scale: 8 }).notNull(),
  reason: text().notNull(),
  createdBy: uuid().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const walletDepositAddress = pgTable(
  'wallet_deposit_address',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    currency: text().notNull(),
    address: text().notNull(),
    providerName: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_deposit_address_user_id_currency_idx').on(t.userId, t.currency),
    index('wallet_deposit_address_address_idx').on(t.address),
  ],
);

// Global fiat/crypto auto-withdrawal thresholds (BF-211), Super-Admin-editable at runtime.
// singletonKey's unique constraint DB-enforces exactly one row ever ('global').
export const walletAutoWithdrawalConfig = pgTable('wallet_auto_withdrawal_config', {
  id: uuid().primaryKey().defaultRandom(),
  singletonKey: text().notNull().unique().default('global'),
  fiatThreshold: decimal({ precision: 18, scale: 8 }).notNull(),
  cryptoThreshold: decimal({ precision: 18, scale: 8 }).notNull(),
  updatedBy: uuid(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type Wallet = typeof wallet.$inferSelect;
export type WalletTransaction = typeof walletTransaction.$inferSelect;
export type AutoWithdrawalRule = typeof autoWithdrawalRule.$inferSelect;
export type WalletDepositAddress = typeof walletDepositAddress.$inferSelect;
export type WalletAutoWithdrawalConfig = typeof walletAutoWithdrawalConfig.$inferSelect;

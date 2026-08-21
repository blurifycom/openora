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
  type TagKey,
  MONEY_PRECISION,
  MONEY_SCALE,
} from '@openora/core/contracts';
import {
  BONUS_CREDIT_SOURCE_TYPES,
  BONUS_CREDIT_STATUSES,
  type BonusCreditSourceType,
  type BonusCreditStatus,
} from '../contract/index.js';

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

export const walletBonusCreditSourceTypeEnum = pgEnum(
  'wallet_bonus_credit_source_type',
  BONUS_CREDIT_SOURCE_TYPES,
);

export const walletBonusCreditStatusEnum = pgEnum(
  'wallet_bonus_credit_status',
  BONUS_CREDIT_STATUSES,
);

export const wallet = pgTable('wallet', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().unique('wallet_user_id_unique'),
  currency: text().notNull().default('USD'),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
});

export const walletBalance = pgTable(
  'wallet_balance',
  {
    id: uuid().primaryKey().defaultRandom(),
    walletId: uuid()
      .notNull()
      .references(() => wallet.id),
    currency: text().notNull(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull().default('0'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('wallet_balance_wallet_id_currency_idx').on(t.walletId, t.currency)],
);

export const walletTransaction = pgTable(
  'wallet_transaction',
  {
    id: uuid().primaryKey().defaultRandom(),
    walletId: uuid()
      .notNull()
      .references(() => wallet.id),
    type: walletTransactionTypeEnum().notNull(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
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
  threshold: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
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
    network: text(),
    address: text().notNull(),
    tag: text(),
    providerName: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_deposit_address_user_id_currency_network_idx')
      .on(t.userId, t.currency, t.network)
      .where(sql`${t.network} IS NOT NULL`),
    uniqueIndex('wallet_deposit_address_user_id_currency_idx')
      .on(t.userId, t.currency)
      .where(sql`${t.network} IS NULL`),
    uniqueIndex('wallet_deposit_address_address_tag_idx')
      .on(t.address, t.tag)
      .where(sql`${t.tag} IS NOT NULL`),
    uniqueIndex('wallet_deposit_address_address_network_currency_idx')
      .on(t.address, t.network, t.currency)
      .where(sql`${t.tag} IS NULL AND ${t.network} IS NOT NULL`),
    index('wallet_deposit_address_address_idx').on(t.address),
  ],
);

export const walletProviderVault = pgTable(
  'wallet_provider_vault',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    providerName: text().notNull(),
    vaultAccountId: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_provider_vault_user_id_provider_name_idx').on(t.userId, t.providerName),
    uniqueIndex('wallet_provider_vault_provider_name_vault_account_id_idx').on(
      t.providerName,
      t.vaultAccountId,
    ),
  ],
);

// Global fiat/crypto auto-withdrawal thresholds (BF-211), Super-Admin-editable at runtime.
// singletonKey's unique constraint DB-enforces exactly one row ever ('global').
export const walletAutoWithdrawalConfig = pgTable('wallet_auto_withdrawal_config', {
  id: uuid().primaryKey().defaultRandom(),
  singletonKey: text().notNull().unique().default('global'),
  fiatThreshold: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
  cryptoThreshold: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
  excludeRiskFlags: text()
    .array()
    .$type<TagKey[]>()
    .notNull()
    .default(
      sql`ARRAY['high_risk','bonus_abuser','kyc_rejected','withdrawal_review','multi_account']::text[]`,
    ),
  updatedBy: uuid(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// One row per gift/rain credit (BF-326). Rollover-locked until `rolloverProgress`
// (accumulated 100% of every casino wager while `active`) reaches `rolloverRequired`
// (creditedAmount * rolloverMultiplier, snapshotted at credit time - a later config
// change never retroactively changes an already-created row). No FK back to
// player_gift/player_rain: neither call site has that row's id available at credit
// time (see wallet-commands.service.ts), and sourceType alone is sufficient.
export const walletBonusCredit = pgTable(
  'wallet_bonus_credit',
  {
    id: uuid().primaryKey().defaultRandom(),
    walletId: uuid()
      .notNull()
      .references(() => wallet.id),
    // Bare uuid, not a FK - userId is the identity module's row, out of this module's reach.
    userId: uuid().notNull(),
    currency: text().notNull(),
    sourceType: walletBonusCreditSourceTypeEnum().$type<BonusCreditSourceType>().notNull(),
    creditedAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    rolloverMultiplier: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    rolloverRequired: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    rolloverProgress: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    status: walletBonusCreditStatusEnum().$type<BonusCreditStatus>().notNull().default('active'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // The progress-update lookup (debit-time waterfall) and the withdrawal-lock sum both
    // filter on exactly this triple, ordered by createdAt for the waterfall.
    index('wallet_bonus_credit_user_id_currency_status_idx').on(t.userId, t.currency, t.status),
    index('wallet_bonus_credit_wallet_id_idx').on(t.walletId),
  ],
);

// Global rollover-multiplier singleton (BF-326), Super-Admin-editable at runtime.
// singletonKey's unique constraint DB-enforces exactly one row ever ('global'). No
// `enabled` toggle - the AC only asks for a configurable multiplier, not a kill switch.
export const walletBonusRolloverConfig = pgTable('wallet_bonus_rollover_config', {
  id: uuid().primaryKey().defaultRandom(),
  singletonKey: text().notNull().unique().default('global'),
  multiplier: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
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
export type WalletBonusCredit = typeof walletBonusCredit.$inferSelect;
export type WalletBonusRolloverConfig = typeof walletBonusRolloverConfig.$inferSelect;

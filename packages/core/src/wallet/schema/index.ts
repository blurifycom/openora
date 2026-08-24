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
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';
import {
  WALLET_RAILS,
  WALLET_TRANSACTION_STATUSES,
  WALLET_TRANSACTION_TYPES,
  WALLET_CUSTODY_SWEEP_STATUSES,
  WALLET_JOB_RUN_STATUSES,
  WALLET_RECONCILIATION_FINDING_KINDS,
  WALLET_RECONCILIATION_FINDING_STATUSES,
  type WalletRail,
  type WalletTransactionStatus,
  type WalletCustodySweepStatus,
  type WalletJobRunStatus,
  type WalletReconciliationFindingKind,
  type WalletReconciliationFindingStatus,
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
    // The chain this moved on. A currency does not identify one, so reconciliation and
    // reporting are per (currency, network). Null on a fiat rail and on any internal
    // transaction type (bet/win/bonus) that never touches a chain.
    network: text(),
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
    destinationWalletId: text(),
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
    index('wallet_transaction_currency_network_idx').on(t.currency, t.network),
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

// A player's own address book: named payout destinations they pick from at withdrawal
// time instead of re-typing a 40-character string. Never validated on-chain here - the
// payment provider rejects a malformed address when the payout is actually attempted.
export const walletWithdrawalAddress = pgTable(
  'wallet_withdrawal_address',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Cross-module (identity), bare uuid - no .references, the user table is another
    // domain's. Every read and write is scoped on this column.
    userId: uuid().notNull(),
    label: text().notNull(),
    currency: text().notNull(),
    network: text().notNull(),
    address: text().notNull(),
    // Which custody provider `providerWalletId` belongs to. Without it a provider swap would
    // silently reuse the previous vendor's id and pay out to whatever that id now names.
    providerName: text(),
    // The provider-side whitelisted destination this address was registered as, in whatever
    // form the bound custody vendor names one. Null when the adapter does not whitelist - a
    // synchronous PSP has no such concept - and the payout path then has nothing to send to,
    // which is the intended failure: an unwhitelisted address must not be payable.
    providerWalletId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A double submit conflicts instead of duplicating the same destination twice.
    uniqueIndex('wallet_withdrawal_address_user_id_currency_network_address_idx').on(
      t.userId,
      t.currency,
      t.network,
      t.address,
    ),
    index('wallet_withdrawal_address_user_id_created_at_idx').on(t.userId, t.createdAt),
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

// Global fiat/crypto auto-withdrawal thresholds, Super-Admin-editable at runtime.
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

export const walletBonusCredit = pgTable(
  'wallet_bonus_credit',
  {
    id: uuid().primaryKey().defaultRandom(),
    walletId: uuid()
      .notNull()
      .references(() => wallet.id),
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
    index('wallet_bonus_credit_user_id_currency_status_idx').on(t.userId, t.currency, t.status),
    index('wallet_bonus_credit_wallet_id_idx').on(t.walletId),
  ],
);

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

// Chain-level behaviour (how the vendor hands out addresses) is deliberately NOT here -
// that belongs to the bound payment adapter, which owns its own vendor vocabulary.
export const walletAsset = pgTable(
  'wallet_asset',
  {
    id: uuid().primaryKey().defaultRandom(),
    currency: text().notNull(),
    network: text().notNull(),
    providerAssetId: text().notNull(),
    minDeposit: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    minWithdrawal: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    withdrawalFee: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    // Independent: an asset can take deposits before it can pay out.
    depositEnabled: boolean().notNull().default(true),
    withdrawalEnabled: boolean().notNull().default(true),
    // Which bound payment vendor settles this (currency, network) pair. Core treats
    // this as an opaque operator-chosen key, never a vendor's product name - null
    // means the default single binding (the only adapter bound to PAYMENT_ADAPTER).
    providerName: text(),
    // The maximum network fee tolerated when sweeping this asset from a per-player
    // custody container into the pool. Null means no ceiling. Per-asset, not global:
    // fee units differ per chain, so one global number cannot compare a fee
    // denominated in one chain's native coin against another's.
    sweepFeeCeiling: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    // Below this pooled balance, the sweep fee ceiling is ignored - running the pool
    // dry to save a fee costs more than the fee. Null means never override the ceiling.
    poolLiquidityFloor: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('wallet_asset_currency_network_idx').on(t.currency, t.network)],
);

export const walletCustodySweepStatusEnum = pgEnum(
  'wallet_custody_sweep_status',
  WALLET_CUSTODY_SWEEP_STATUSES,
);

// An internal transfer of vendor-side funds between containers (per-player custody ->
// pooled account). Must NEVER touch a player balance - the player was already credited
// at deposit time, so this table only tracks the vendor-side movement.
export const walletCustodySweep = pgTable(
  'wallet_custody_sweep',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Cross-module (identity), bare uuid - whose custody container this swept.
    userId: uuid().notNull(),
    providerName: text().notNull(),
    currency: text().notNull(),
    network: text().notNull(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    estimatedFee: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    externalId: text(),
    // Opaque vendor-side id of the pool the funds landed in. Player funds must stay
    // separate from operator funds, and a regulator asks which account received them -
    // without this the ledger can evidence that a sweep happened but not where it went.
    poolRef: text(),
    txHash: text(),
    // `unknown`: a thrown sweepToPool cannot distinguish "vendor never saw it" from
    // "vendor accepted it and the response was lost". The row moves to `unknown` and
    // KEEPS holding the in-flight guard below - releasing it would risk a double
    // transfer of real funds.
    status: walletCustodySweepStatusEnum()
      .$type<WalletCustodySweepStatus>()
      .notNull()
      .default('pending'),
    runId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    // The durable in-flight guard: at most one pending/processing/unknown sweep per
    // (user, currency, network) at a time.
    uniqueIndex('wallet_custody_sweep_user_id_currency_network_idx')
      .on(t.userId, t.currency, t.network)
      .where(sql`status IN ('pending','processing','unknown')`),
    uniqueIndex('wallet_custody_sweep_external_id_idx')
      .on(t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index('wallet_custody_sweep_status_created_at_idx').on(t.status, t.createdAt),
    index('wallet_custody_sweep_provider_name_created_at_idx').on(t.providerName, t.createdAt),
  ],
);

export const walletJobRunStatusEnum = pgEnum('wallet_job_run_status', WALLET_JOB_RUN_STATUSES);

// Claim-based concurrency guard plus run history for the wallet cron jobs (sweep,
// reconciliation). Claiming a run IS the insert; a unique-index conflict means another
// cycle already owns it. Not a session-level advisory lock: a lock held by a pooled
// connection that gets returned to the pool is a deadlock waiting to happen. A partial
// unique index is the same guarantee, enforced by the database, with no connection
// affinity.
export const walletJobRun = pgTable(
  'wallet_job_run',
  {
    id: uuid().primaryKey().defaultRandom(),
    jobName: text().notNull(),
    runId: uuid().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    status: walletJobRunStatusEnum().$type<WalletJobRunStatus>().notNull().default('running'),
    summary: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one live run per job.
    uniqueIndex('wallet_job_run_job_name_idx')
      .on(t.jobName)
      .where(sql`${t.finishedAt} IS NULL`),
    index('wallet_job_run_job_name_started_at_idx').on(t.jobName, t.startedAt),
  ],
);

export const walletReconciliationFindingKindEnum = pgEnum(
  'wallet_reconciliation_finding_kind',
  WALLET_RECONCILIATION_FINDING_KINDS,
);

export const walletReconciliationFindingStatusEnum = pgEnum(
  'wallet_reconciliation_finding_status',
  WALLET_RECONCILIATION_FINDING_STATUSES,
);

// A finding is a report, never a credit instruction - nothing automated may credit a
// player or move funds off the back of a row in this table.
export const walletReconciliationFinding = pgTable(
  'wallet_reconciliation_finding',
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid().notNull(),
    providerName: text().notNull(),
    kind: walletReconciliationFindingKindEnum().$type<WalletReconciliationFindingKind>().notNull(),
    currency: text(),
    network: text(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    address: text(),
    tag: text(),
    txHash: text(),
    externalId: text(),
    transactionId: uuid(),
    detail: text(),
    status: walletReconciliationFindingStatusEnum()
      .$type<WalletReconciliationFindingStatus>()
      .notNull()
      .default('open'),
    // Cross-module (identity admin user), bare uuid.
    resolvedBy: uuid(),
    resolvedAt: timestamp({ withTimezone: true }),
    resolutionNote: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Re-running reconciliation over an overlapping window must not duplicate findings.
    uniqueIndex('wallet_reconciliation_finding_kind_external_id_idx')
      .on(t.kind, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index('wallet_reconciliation_finding_status_created_at_idx').on(t.status, t.createdAt),
    index('wallet_reconciliation_finding_run_id_idx').on(t.runId),
  ],
);

export type Wallet = typeof wallet.$inferSelect;
export type WalletTransaction = typeof walletTransaction.$inferSelect;
export type AutoWithdrawalRule = typeof autoWithdrawalRule.$inferSelect;
export type WalletDepositAddress = typeof walletDepositAddress.$inferSelect;
export type WalletWithdrawalAddressRow = typeof walletWithdrawalAddress.$inferSelect;
export type WalletAutoWithdrawalConfig = typeof walletAutoWithdrawalConfig.$inferSelect;
export type WalletBonusCredit = typeof walletBonusCredit.$inferSelect;
export type WalletBonusRolloverConfig = typeof walletBonusRolloverConfig.$inferSelect;
export type WalletAssetRow = typeof walletAsset.$inferSelect;
export type WalletCustodySweep = typeof walletCustodySweep.$inferSelect;
export type WalletJobRun = typeof walletJobRun.$inferSelect;
export type WalletReconciliationFinding = typeof walletReconciliationFinding.$inferSelect;

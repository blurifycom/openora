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
  integer,
  primaryKey,
} from 'drizzle-orm/pg-core';
import {
  WALLET_RAILS,
  WALLET_TRANSACTION_STATUSES,
  WALLET_TRANSACTION_TYPES,
  WALLET_CUSTODY_SWEEP_STATUSES,
  WALLET_JOB_RUN_STATUSES,
  WALLET_RECONCILIATION_FINDING_KINDS,
  WALLET_RECONCILIATION_FINDING_STATUSES,
  WALLET_DEPOSIT_STATUS_EVENT_STATUSES,
  ON_RAMP_STATUSES,
  WAGER_PRODUCTS,
  LEDGER_PROJECTIONS,
  TURNOVER_ENTRY_SOURCES,
  TURNOVER_ENTRY_STATUSES,
  TURNOVER_STAKE_STATES,
  LEDGER_V1_KEYED_OPERATIONS,
  PLAYER_STATUSES,
  GATED_LIMIT_TYPES,
  GATED_LIMIT_PERIODS,
  type OnRampStatus,
  type WalletRail,
  type WalletTransactionStatus,
  type WalletCustodySweepStatus,
  type WalletJobRunStatus,
  type WalletReconciliationFindingKind,
  type WalletReconciliationFindingStatus,
  type TagKey,
  type WagerProduct,
  MONEY_PRECISION,
  MONEY_SCALE,
} from '@openora/core/contracts';
import {
  BONUS_CREDIT_SOURCE_TYPES,
  BONUS_CREDIT_STATUSES,
  MANUAL_ADJUSTMENT_DIRECTIONS,
  type BonusCreditSourceType,
  type BonusCreditStatus,
  type ManualAdjustmentDirection,
} from '../contract/index.js';

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

export const walletTransactionDirectionEnum = pgEnum(
  'wallet_transaction_direction',
  MANUAL_ADJUSTMENT_DIRECTIONS,
);

export const walletWagerProductEnum = pgEnum('wallet_wager_product', WAGER_PRODUCTS);
export const ledgerApiOperationEnum = pgEnum('ledger_api_operation', LEDGER_V1_KEYED_OPERATIONS);
export const walletTurnoverEntrySourceEnum = pgEnum(
  'wallet_turnover_entry_source',
  TURNOVER_ENTRY_SOURCES,
);
export const walletTurnoverEntryStatusEnum = pgEnum(
  'wallet_turnover_entry_status',
  TURNOVER_ENTRY_STATUSES,
);
export const walletTurnoverStakeStateEnum = pgEnum(
  'wallet_turnover_stake_state',
  TURNOVER_STAKE_STATES,
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

export const walletBalanceBaseline = pgTable(
  'wallet_balance_baseline',
  {
    id: uuid().primaryKey().defaultRandom(),
    walletId: uuid()
      .notNull()
      .references(() => wallet.id),
    currency: text().notNull(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    asOf: timestamp({ withTimezone: true }).notNull(),
    runId: uuid(),
    findingId: uuid().references(() => walletReconciliationFinding.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_balance_baseline_wallet_id_currency_as_of_idx').on(
      t.walletId,
      t.currency,
      t.asOf,
    ),
  ],
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
    balanceAfter: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    network: text(),
    status: walletTransactionStatusEnum()
      .$type<WalletTransactionStatus>()
      .notNull()
      .default('pending'),
    rail: walletRailEnum().$type<WalletRail>(),
    direction: walletTransactionDirectionEnum().$type<ManualAdjustmentDirection>(),
    reviewedBy: uuid(),
    reviewedAt: timestamp({ withTimezone: true }),
    reviewReason: text(),
    autoApprovalPivotAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    referenceCurrency: text(),
    referenceAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    referenceRate: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    referenceRateAsOf: timestamp({ withTimezone: true }),
    fee: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    providerName: text(),
    providerRefId: text(),
    externalRoundId: text(),
    wagerProduct: walletWagerProductEnum(),
    wagerRtp: decimal({ precision: 19, scale: 18 }),
    destinationAddress: text(),
    destinationTag: text(),
    destinationWalletId: text(),
    txHash: text(),
    metadata: text(),
    idempotencyKey: uuid(),
    correctionRequestedAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    realShare: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    reversedTransactionId: uuid(),
    turnoverContribution: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    turnoverState: walletTurnoverStakeStateEnum(),
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
    index('wallet_transaction_destination_address_idx').on(sql`lower(${t.destinationAddress})`),
    index('wallet_transaction_provider_ref_idx').on(t.providerRefId),
    index('wallet_transaction_status_type_created_at_idx').on(t.status, t.type, t.createdAt),
    index('wallet_transaction_wallet_id_type_status_idx').on(t.walletId, t.type, t.status),
    index('wallet_transaction_wallet_id_status_created_at_idx').on(
      t.walletId,
      t.status,
      t.createdAt,
    ),
    uniqueIndex('wallet_transaction_provider_ref_id_idx')
      .on(t.providerName, t.providerRefId)
      .where(sql`${t.providerRefId} IS NOT NULL`),
    index('wallet_transaction_external_round_id_idx').on(t.externalRoundId),
    index('wallet_transaction_wallet_id_external_round_id_idx')
      .on(t.walletId, t.externalRoundId)
      .where(sql`${t.externalRoundId} IS NOT NULL`),
    uniqueIndex('wallet_transaction_wallet_id_idempotency_key_idx')
      .on(t.walletId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    uniqueIndex('wallet_transaction_reversed_transaction_id_idx')
      .on(t.reversedTransactionId)
      .where(sql`${t.reversedTransactionId} IS NOT NULL`),
  ],
);

type LedgerRow = typeof walletTransaction.$inferSelect;

export type PlayLeg = {
  type: Extract<LedgerRow['type'], 'bet' | 'bet_reversal' | 'win' | 'win_reversal'>;
  direction: NonNullable<LedgerRow['direction']>;
};

export const WAGER_LEGS = [
  { type: 'bet', direction: 'debit' },
  { type: 'bet_reversal', direction: 'credit' },
] as const satisfies readonly PlayLeg[];

export const LOSS_LEGS = [
  ...WAGER_LEGS,
  { type: 'win', direction: 'credit' },
  { type: 'win_reversal', direction: 'debit' },
] as const satisfies readonly PlayLeg[];

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

export const walletWithdrawalHold = pgTable(
  'wallet_withdrawal_hold',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    source: text().notNull(),
    reason: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('wallet_withdrawal_hold_user_id_source_idx').on(t.userId, t.source)],
);

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

export const walletWithdrawalAddress = pgTable(
  'wallet_withdrawal_address',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    label: text().notNull(),
    currency: text().notNull(),
    network: text().notNull(),
    address: text().notNull(),
    destinationTag: text(),
    providerName: text(),
    providerWalletId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_withdrawal_address_user_id_currency_network_address_idx').on(
      t.userId,
      t.currency,
      t.network,
      t.address,
      sql`coalesce(${t.destinationTag}, '')`,
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
  velocityCount: integer().default(3),
  velocityWindowHours: integer().notNull().default(24),
  updatedBy: uuid(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const walletTurnover = pgTable('wallet_turnover', {
  userId: uuid().primaryKey(),
  pivotCurrency: text().notNull(),
  required: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull().default('0'),
  progress: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull().default('0'),
  pendingCount: integer().notNull().default(0),
  clearedAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const walletTurnoverEntry = pgTable(
  'wallet_turnover_entry',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    source: walletTurnoverEntrySourceEnum().notNull(),
    sourceRef: text().notNull(),
    currency: text().notNull(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    multiplier: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    requiredInCurrency: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    pivotValue: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    required: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    status: walletTurnoverEntryStatusEnum().notNull(),
    pricedAt: timestamp({ withTimezone: true }),
    clearedAt: timestamp({ withTimezone: true }),
    clearedBy: uuid(),
    clearReason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_turnover_entry_source_ref_idx').on(t.source, t.sourceRef),
    index('wallet_turnover_entry_user_id_created_at_idx').on(
      t.userId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('wallet_turnover_entry_pending_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const walletTurnoverConfig = pgTable('wallet_turnover_config', {
  id: uuid().primaryKey().defaultRandom(),
  singletonKey: text().notNull().unique().default('global'),
  productPercent: jsonb().$type<Partial<Record<WagerProduct, number>>>().notNull().default({}),
  updatedBy: uuid(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
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
    depositEnabled: boolean().notNull().default(true),
    withdrawalEnabled: boolean().notNull().default(true),
    providerName: text(),
    sweepDustThreshold: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    sweepFeeCeiling: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
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

export const walletCustodySweep = pgTable(
  'wallet_custody_sweep',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    providerName: text().notNull(),
    currency: text().notNull(),
    network: text().notNull(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    estimatedFee: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    externalId: text(),
    poolRef: text(),
    txHash: text(),
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
    sourceAddress: text(),
    externalId: text(),
    transactionId: uuid(),
    detail: text(),
    status: walletReconciliationFindingStatusEnum()
      .$type<WalletReconciliationFindingStatus>()
      .notNull()
      .default('open'),
    resolvedBy: uuid(),
    resolvedAt: timestamp({ withTimezone: true }),
    resolutionNote: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_reconciliation_finding_kind_provider_external_id_idx')
      .on(t.kind, t.providerName, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index('wallet_reconciliation_finding_status_created_at_idx').on(t.status, t.createdAt),
    index('wallet_reconciliation_finding_run_id_idx').on(t.runId),
    index('wallet_reconciliation_finding_open_kind_external_id_idx')
      .on(t.kind, t.providerName, t.externalId)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const walletRefundedDeposit = pgTable(
  'wallet_refunded_deposit',
  {
    id: uuid().primaryKey().defaultRandom(),
    providerName: text().notNull(),
    externalId: text().notNull(),
    findingId: uuid()
      .notNull()
      .references(() => walletReconciliationFinding.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_refunded_deposit_provider_external_id_idx').on(
      t.providerName,
      t.externalId,
    ),
  ],
);

export const walletDepositStatusEventStatusEnum = pgEnum(
  'wallet_deposit_status_event_status',
  WALLET_DEPOSIT_STATUS_EVENT_STATUSES,
);

export const walletDepositStatusEvent = pgTable(
  'wallet_deposit_status_event',
  {
    id: uuid().primaryKey().defaultRandom(),
    providerName: text().notNull(),
    externalId: text().notNull(),
    status: walletDepositStatusEventStatusEnum().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_deposit_status_event_provider_external_id_status_idx').on(
      t.providerName,
      t.externalId,
      t.status,
    ),
  ],
);

export const walletOnRampOrderStatusEnum = pgEnum('wallet_on_ramp_order_status', ON_RAMP_STATUSES);

export const walletOnRampOrder = pgTable(
  'wallet_on_ramp_order',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    externalId: text(),
    idempotencyKey: uuid().notNull(),
    checkoutUrl: text(),
    expiresAt: timestamp({ withTimezone: true }),
    fiatAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    fiatCurrency: text().notNull(),
    currency: text().notNull(),
    network: text().notNull(),
    walletAddress: text().notNull(),
    walletTag: text(),
    status: walletOnRampOrderStatusEnum().$type<OnRampStatus>().notNull().default('pending'),
    cryptoAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    txHash: text(),
    gatewayId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('wallet_on_ramp_order_external_id_idx')
      .on(t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    uniqueIndex('wallet_on_ramp_order_user_id_idempotency_key_idx').on(t.userId, t.idempotencyKey),
    index('wallet_on_ramp_order_user_id_status_idx').on(t.userId, t.status),
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
export const ledgerApiRequest = pgTable(
  'ledger_api_request',
  {
    providerName: text().notNull(),
    providerRefId: text().notNull(),
    operation: ledgerApiOperationEnum().notNull(),
    fingerprint: text().notNull(),
    targetRefId: text(),
    response: jsonb().notNull(),
    userId: uuid(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.providerName, t.providerRefId] }),
    index('ledger_api_request_created_at_idx').on(t.createdAt),
    uniqueIndex('ledger_api_request_target_ref_key')
      .on(t.providerName, t.targetRefId)
      .where(sql`${t.targetRefId} IS NOT NULL`),
  ],
);

export const ledgerPlayerStatusEnum = pgEnum('ledger_player_status', PLAYER_STATUSES);

export const ledgerPlayEligibility = pgTable('ledger_play_eligibility', {
  userId: uuid().primaryKey(),
  rgBlocked: boolean().notNull(),
  rgBlockedUntil: timestamp({ withTimezone: true }),
  isActive: boolean().notNull(),
  banned: boolean().notNull(),
  banExpires: timestamp({ withTimezone: true }),
  status: ledgerPlayerStatusEnum(),
  version: integer().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const ledgerUserLimit = pgTable(
  'ledger_user_limit',
  {
    limitId: uuid().primaryKey(),
    userId: uuid().notNull(),
    type: text({ enum: GATED_LIMIT_TYPES }).notNull(),
    period: text({ enum: GATED_LIMIT_PERIODS }).notNull(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    currency: text(),
    changedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index('ledger_user_limit_user_id_idx').on(t.userId)],
);

export const ledgerUserLimitVersion = pgTable('ledger_user_limit_version', {
  userId: uuid().primaryKey(),
  version: integer().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const ledgerProjectionHeartbeat = pgTable('ledger_projection_heartbeat', {
  projection: text({ enum: LEDGER_PROJECTIONS }).primaryKey(),
  beatAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type WalletJobRun = typeof walletJobRun.$inferSelect;
export type WalletReconciliationFinding = typeof walletReconciliationFinding.$inferSelect;
export type WalletRefundedDeposit = typeof walletRefundedDeposit.$inferSelect;
export type WalletDepositStatusEvent = typeof walletDepositStatusEvent.$inferSelect;
export type WalletOnRampOrder = typeof walletOnRampOrder.$inferSelect;

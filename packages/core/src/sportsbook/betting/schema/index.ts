import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  MONEY_PRECISION,
  MONEY_SCALE,
  SPORTSBOOK_BET_RESULTS,
  SPORTSBOOK_BET_STATUSES,
  SPORTSBOOK_CANCEL_REASONS,
  WALLET_CORRECTION_DEBIT_TYPES,
  type SportsbookBetLeg,
} from '@openora/core/contracts';
import {
  SPORTSBOOK_DEBT_ACTIONS,
  SPORTSBOOK_DEBT_STATUSES,
  SPORTSBOOK_FINDING_KINDS,
  SPORTSBOOK_FINDING_STATUSES,
  SPORTSBOOK_PROMOTION_FUNDERS,
  SPORTSBOOK_RECONCILE_MAX_ATTEMPTS,
  SPORTSBOOK_CONFIG_DEFAULTS,
  SPORTSBOOK_PROMOTIONS_DEFAULTS,
  SPORTSBOOK_TRANSACTION_KINDS,
  type SportsbookCurrency,
  type SportsbookDebt,
  type SportsbookPromotionsConfig,
} from '../contract/index.js';

const money = () => decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE });

export const sportsbookBetStatusEnum = pgEnum('sportsbook_bet_status', SPORTSBOOK_BET_STATUSES);
export const sportsbookBetResultEnum = pgEnum('sportsbook_bet_result', SPORTSBOOK_BET_RESULTS);
export const sportsbookCancelReasonEnum = pgEnum(
  'sportsbook_cancel_reason',
  SPORTSBOOK_CANCEL_REASONS,
);
export const sportsbookTransactionKindEnum = pgEnum(
  'sportsbook_transaction_kind',
  SPORTSBOOK_TRANSACTION_KINDS,
);
export const sportsbookDebtStatusEnum = pgEnum('sportsbook_debt_status', SPORTSBOOK_DEBT_STATUSES);
export const sportsbookDebtActionEnum = pgEnum(
  'sportsbook_debt_action_kind',
  SPORTSBOOK_DEBT_ACTIONS,
);
export const sportsbookDebtShortfallTypeEnum = pgEnum(
  'sportsbook_debt_shortfall_type',
  WALLET_CORRECTION_DEBIT_TYPES,
);
export const sportsbookFindingKindEnum = pgEnum(
  'sportsbook_finding_kind',
  SPORTSBOOK_FINDING_KINDS,
);
export const sportsbookPromotionFunderEnum = pgEnum(
  'sportsbook_promotion_funder',
  SPORTSBOOK_PROMOTION_FUNDERS,
);
export const sportsbookFindingStatusEnum = pgEnum(
  'sportsbook_finding_status',
  SPORTSBOOK_FINDING_STATUSES,
);

export const sportsbookConfig = pgTable('sportsbook_config', {
  id: uuid().primaryKey().defaultRandom(),
  singletonKey: text().notNull().unique('sportsbook_config_singleton_key_unique').default('global'),
  enabled: boolean().notNull().default(false),
  suspended: boolean().notNull().default(false),
  currencies: jsonb().$type<SportsbookCurrency[]>().notNull().default([]),
  blockedCountries: text()
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  reserveTimeoutSeconds: integer()
    .notNull()
    .default(SPORTSBOOK_CONFIG_DEFAULTS.reserveTimeoutSeconds),
  settlementGraceMinutes: integer()
    .notNull()
    .default(SPORTSBOOK_CONFIG_DEFAULTS.settlementGraceMinutes),
  sessionTtlMinutes: integer().notNull().default(SPORTSBOOK_CONFIG_DEFAULTS.sessionTtlMinutes),
  promotions: jsonb()
    .$type<SportsbookPromotionsConfig>()
    .notNull()
    .default(SPORTSBOOK_PROMOTIONS_DEFAULTS),
  updatedBy: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
});

export const sportsbookSession = pgTable(
  'sportsbook_session',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    provider: text().notNull(),
    currency: text().notNull(),
    countryCode: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    providerRevokedAt: timestamp({ withTimezone: true }),
    providerOpenedAt: timestamp({ withTimezone: true }),
    providerRevokeAttemptedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sportsbook_session_user_id_live_idx')
      .on(t.userId, t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
    index('sportsbook_session_expires_at_live_idx')
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
    index('sportsbook_session_unacknowledged_expires_at_id_idx')
      .on(t.expiresAt, t.id)
      .where(sql`${t.revokedAt} IS NOT NULL AND ${t.providerRevokedAt} IS NULL`),
  ],
);

export const sportsbookBet = pgTable(
  'sportsbook_bet',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    provider: text().notNull(),
    providerBetId: text().notNull(),
    sessionId: uuid()
      .notNull()
      .references(() => sportsbookSession.id),
    currency: text().notNull(),
    currencyDecimals: integer().notNull(),
    status: sportsbookBetStatusEnum().notNull(),
    result: sportsbookBetResultEnum(),
    stake: money().notNull(),
    potentialPayout: money().notNull(),
    payoutTotal: money().notNull().default('0'),
    cashStake: money().notNull(),
    voidPayout: money().notNull(),
    maxLossRefund: money().notNull().default('0'),
    promotionType: text(),
    promotionId: text(),
    promotionFunder: sportsbookPromotionFunderEnum(),
    promotionPotential: money(),
    promotionPaid: money().notNull().default('0'),
    version: integer().notNull().default(1),
    legs: jsonb().$type<SportsbookBetLeg[]>().notNull(),
    lastLegStartsAt: timestamp({ withTimezone: true }).notNull(),
    reconcileAttempts: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp({ withTimezone: true }),
    settledAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('sportsbook_bet_provider_provider_bet_id_idx').on(t.provider, t.providerBetId),
    index('sportsbook_bet_user_id_created_at_idx').on(t.userId, t.createdAt),
    index('sportsbook_bet_user_id_accepted_at_idx').on(t.userId, t.acceptedAt),
    index('sportsbook_bet_user_id_status_settled_at_idx').on(t.userId, t.status, t.settledAt),
    index('sportsbook_bet_created_at_idx').on(t.createdAt),
    index('sportsbook_bet_accepted_at_idx').on(t.acceptedAt),
    index('sportsbook_bet_status_created_at_idx').on(t.status, t.createdAt, t.id),
    index('sportsbook_bet_reserved_created_at_idx')
      .on(t.createdAt, t.id)
      .where(
        sql`${t.status} = 'reserved' and ${t.reconcileAttempts} < ${sql.raw(String(SPORTSBOOK_RECONCILE_MAX_ATTEMPTS))}`,
      ),
    index('sportsbook_bet_settled_at_idx')
      .on(t.settledAt)
      .where(sql`${t.status} = 'settled'`),
    index('sportsbook_bet_accepted_last_leg_starts_at_idx')
      .on(t.lastLegStartsAt, t.id)
      .where(sql`${t.status} = 'accepted'`),
    check('sportsbook_bet_stake_positive_check', sql`${t.stake} > 0`),
    check('sportsbook_bet_payout_total_non_negative_check', sql`${t.payoutTotal} >= 0`),
    check(
      'sportsbook_bet_cash_stake_check',
      sql`${t.cashStake} IN (0, ${t.stake}) AND (${t.cashStake} = ${t.stake} OR ${t.promotionType} IS NOT NULL)`,
    ),
    check(
      'sportsbook_bet_void_payout_check',
      sql`${t.voidPayout} IN (0, ${t.stake}) AND (${t.cashStake} = 0 OR ${t.voidPayout} = ${t.stake})`,
    ),
    check(
      'sportsbook_bet_max_loss_refund_check',
      sql`${t.maxLossRefund} IN (0, ${t.cashStake}) AND (${t.maxLossRefund} = 0 OR ${t.promotionType} IS NOT NULL)`,
    ),
    check(
      'sportsbook_bet_promotion_paid_check',
      sql`${t.promotionPaid} >= 0 AND ${t.promotionPaid} <= ${t.payoutTotal} AND (${t.promotionPaid} = 0 OR ${t.promotionType} IS NOT NULL) AND (${t.cashStake} > 0 OR ${t.promotionPaid} = ${t.payoutTotal})`,
    ),
    check(
      'sportsbook_bet_promotion_funder_check',
      sql`(${t.promotionType} IS NULL) = (${t.promotionFunder} IS NULL)`,
    ),
    check(
      'sportsbook_bet_result_payout_check',
      sql`(${t.result} IS DISTINCT FROM 'void' OR ${t.payoutTotal} = ${t.voidPayout} OR (${t.cashStake} = 0 AND ${t.payoutTotal} = 0)) AND (${t.result} IS DISTINCT FROM 'lost' OR ${t.payoutTotal} <= ${t.maxLossRefund})`,
    ),
  ],
);

export const sportsbookBetTransaction = pgTable(
  'sportsbook_bet_transaction',
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: text().notNull(),
    providerTxId: text().notNull(),
    providerBetId: text().notNull(),
    betId: uuid().references(() => sportsbookBet.id),
    userId: uuid(),
    kind: sportsbookTransactionKindEnum().notNull(),
    amount: money().notNull().default('0'),
    potentialPayout: money(),
    legs: jsonb().$type<SportsbookBetLeg[]>(),
    promotionPotential: money(),
    betVersion: integer().notNull().default(0),
    fingerprint: text().notNull(),
    result: sportsbookBetResultEnum(),
    cancelReason: sportsbookCancelReasonEnum(),
    walletTransactionIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    balanceAfter: money(),
    currency: text(),
    promotionAmount: money(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sportsbook_bet_transaction_provider_provider_tx_id_idx').on(
      t.provider,
      t.providerTxId,
    ),
    uniqueIndex('sportsbook_bet_transaction_bet_origin_idx')
      .on(t.provider, t.providerBetId)
      .where(sql`${t.kind} = 'reserve' OR ${t.betId} IS NULL`),
    index('sportsbook_bet_transaction_bet_id_created_at_idx').on(t.betId, t.createdAt),
    index('sportsbook_bet_transaction_kind_created_at_idx').on(t.kind, t.createdAt),
    index('sportsbook_bet_transaction_promotion_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.promotionAmount} > 0`),
  ],
);

export const sportsbookPlayerRestriction = pgTable('sportsbook_player_restriction', {
  userId: uuid().primaryKey(),
  reason: text().notNull(),
  restrictedBy: uuid().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const sportsbookPlayerDebt = pgTable(
  'sportsbook_player_debt',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    currency: text().notNull(),
    owed: money().notNull().default('0'),
    collected: money().notNull().default('0'),
    writtenOff: money().notNull().default('0'),
    outstanding: money().notNull().default('0'),
    status: sportsbookDebtStatusEnum().notNull().default('open'),
    writtenOffBy: uuid(),
    writtenOffReason: text(),
    writtenOffAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('sportsbook_player_debt_user_id_currency_idx').on(t.userId, t.currency),
    index('sportsbook_player_debt_status_updated_at_idx').on(t.status, t.updatedAt),
    index('sportsbook_player_debt_updated_at_idx').on(t.updatedAt, t.id),
    check(
      'sportsbook_player_debt_outstanding_check',
      sql`${t.outstanding} = ${t.owed} - ${t.collected} - ${t.writtenOff} AND ${t.outstanding} >= 0 AND ${t.owed} >= 0 AND ${t.collected} >= 0 AND ${t.writtenOff} >= 0`,
    ),
  ],
);

export const sportsbookDebtShortfall = pgTable(
  'sportsbook_debt_shortfall',
  {
    id: uuid().primaryKey().defaultRandom(),
    seq: bigserial({ mode: 'number' }).notNull(),
    debtId: uuid()
      .notNull()
      .references(() => sportsbookPlayerDebt.id),
    betId: uuid()
      .notNull()
      .references(() => sportsbookBet.id),
    type: sportsbookDebtShortfallTypeEnum().notNull(),
    amount: money().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sportsbook_debt_shortfall_debt_id_seq_idx').on(t.debtId, t.seq),
    check('sportsbook_debt_shortfall_amount_check', sql`${t.amount} > 0`),
  ],
);

export const sportsbookDebtAction = pgTable('sportsbook_debt_action', {
  id: uuid().primaryKey().defaultRandom(),
  idempotencyKey: uuid().notNull().unique('sportsbook_debt_action_idempotency_key_unique'),
  debtId: uuid()
    .notNull()
    .references(() => sportsbookPlayerDebt.id),
  action: sportsbookDebtActionEnum().notNull(),
  reason: text(),
  result: jsonb().$type<SportsbookDebt>().notNull(),
  actorId: uuid().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const sportsbookReconciliationFinding = pgTable(
  'sportsbook_reconciliation_finding',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: sportsbookFindingKindEnum().notNull(),
    provider: text(),
    betId: uuid().references(() => sportsbookBet.id),
    userId: uuid(),
    dedupeKey: text().notNull(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: sportsbookFindingStatusEnum().notNull().default('open'),
    resolvedBy: uuid(),
    resolvedAt: timestamp({ withTimezone: true }),
    resolutionNote: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sportsbook_reconciliation_finding_open_dedupe_key_idx')
      .on(t.dedupeKey)
      .where(sql`${t.status} = 'open'`),
    index('sportsbook_reconciliation_finding_status_created_at_idx').on(t.status, t.createdAt),
    index('sportsbook_reconciliation_finding_created_at_idx').on(t.createdAt, t.id),
    index('sportsbook_reconciliation_finding_bet_id_kind_idx').on(t.betId, t.kind),
    index('sportsbook_reconciliation_finding_user_id_created_at_idx').on(
      t.userId,
      t.createdAt,
      t.id,
    ),
  ],
);

export type SportsbookConfigRow = typeof sportsbookConfig.$inferSelect;
export type SportsbookSessionRow = typeof sportsbookSession.$inferSelect;
export type SportsbookBetRow = typeof sportsbookBet.$inferSelect;
export type SportsbookBetTransactionRow = typeof sportsbookBetTransaction.$inferSelect;
export type SportsbookPlayerDebtRow = typeof sportsbookPlayerDebt.$inferSelect;
export type SportsbookDebtShortfallRow = typeof sportsbookDebtShortfall.$inferSelect;
export type SportsbookFindingRow = typeof sportsbookReconciliationFinding.$inferSelect;

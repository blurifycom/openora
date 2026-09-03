import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  decimal,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import {
  KYC_STATUSES,
  KYC_TIERS,
  EXCLUSION_KINDS,
  EXCLUSION_STATUSES,
  RG_FLAG_TYPES,
  RG_FLAG_STATUSES,
  limitTypes,
  limitPeriods,
  LIMIT_CHANGE_KINDS,
  geoRuleActions,
  MONEY_SCALE,
  MONEY_PRECISION,
  type KycRiskSignals,
  type KycCheckResult,
} from '@openora/core/contracts';
import { KYC_DOCUMENT_TYPES, KYC_TRIGGERED_BY } from '../contract/enums.js';
import type { RgFlagDetail } from '../contract/rg.js';

export const kycVerificationStatus = pgEnum('kyc_verification_status', KYC_STATUSES);
export const kycVerificationTier = pgEnum('kyc_verification_tier', KYC_TIERS);
export const kycTriggeredBy = pgEnum('kyc_triggered_by', KYC_TRIGGERED_BY);
export const rgExclusionKind = pgEnum('rg_exclusion_kind', EXCLUSION_KINDS);
export const rgExclusionStatus = pgEnum('rg_exclusion_status', EXCLUSION_STATUSES);
export const rgFlagType = pgEnum('rg_flag_type', RG_FLAG_TYPES);
export const rgFlagStatus = pgEnum('rg_flag_status', RG_FLAG_STATUSES);
export const limitChangeKind = pgEnum('limit_change_kind', LIMIT_CHANGE_KINDS);

// Postgres treats every NULL as distinct in a unique index, so a session-type row uses
// this sentinel instead of NULL to stay covered by the unique index below.
export const SESSION_LIMIT_CURRENCY = 'SESSION';

export const userLimit = pgTable(
  'user_limit',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    type: text({ enum: limitTypes }).notNull(),
    // Exactly one of the two is set, discriminated by `type`: money-type limits
    // (deposit/wager/loss) carry amount; the session-type limit carries minutes.
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    minutes: integer(),
    currency: text(),
    period: text({ enum: limitPeriods }).notNull(),
    pendingKind: limitChangeKind(),
    pendingAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    pendingMinutes: integer(),
    pendingCurrency: text(),
    pendingRequestedAt: timestamp({ withTimezone: true }),
    pendingEffectiveAt: timestamp({ withTimezone: true }),
    pendingExpiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('user_limit_user_id_type_period_currency_key').on(
      t.userId,
      t.type,
      t.period,
      t.currency,
    ),
    index('user_limit_user_id_idx').on(t.userId),
    index('user_limit_pending_expires_at_idx').on(t.pendingExpiresAt),
  ],
);

export const geoRule = pgTable('geo_rule', {
  id: uuid().primaryKey().defaultRandom(),
  countryCode: text().notNull().unique('geo_rule_country_code_unique'),
  action: text({ enum: geoRuleActions }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// Append-only history: the player's current verification is the latest row by createdAt.
export const kycVerification = pgTable(
  'kyc_verification',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    provider: text().notNull(),
    referenceId: text().notNull(),
    tier: kycVerificationTier().notNull().default('basic'),
    status: kycVerificationStatus().notNull(),
    documentTypes: jsonb().$type<(typeof KYC_DOCUMENT_TYPES)[number][]>().notNull().default([]),
    decisionReason: text(),
    riskSignals: jsonb().$type<KycRiskSignals>(),
    checks: jsonb().$type<KycCheckResult[]>(),
    triggeredBy: kycTriggeredBy().notNull(),
    // High-water mark of deposits at the last reverify_threshold fire, so re-KYC triggers
    // once per fresh threshold band rather than on every deposit.
    triggerDeposits: decimal({ precision: 18, scale: 2 }),
    // The wall-clock time THIS decision was received (webhook arrival / submit time),
    // never job-processing time - a job/webhook retry or out-of-order worker execution
    // must not reorder this. `reconcile` refuses to apply an incoming decision older
    // than this watermark, closing the window where two vendor decisions (eg
    // approved then rejected) interleave out of order and leave the wrong one applied.
    decisionReceivedAt: timestamp({ withTimezone: true }),
    submittedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('kyc_verification_user_id_tier_created_at_idx').on(t.userId, t.tier, t.createdAt),
    uniqueIndex('kyc_verification_user_id_reference_id_tier_key').on(
      t.userId,
      t.referenceId,
      t.tier,
    ),
    index('kyc_verification_status_idx').on(t.status),
  ],
);

// Cooling-off + self-exclusion. The partial-unique on (userId, kind) WHERE active
// guarantees at most one open exclusion of each kind per player. Auto-expiry is by
// the login gate comparing `now >= expiresAt`, not a background job.
export const rgExclusion = pgTable(
  'rg_exclusion',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    kind: rgExclusionKind().notNull(),
    status: rgExclusionStatus().notNull().default('active'),
    reason: text().notNull(),
    isPermanent: boolean().notNull().default(false),
    startsAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }),
    liftedAt: timestamp({ withTimezone: true }),
    liftedReason: text(),
    liftedBy: uuid(),
    createdBy: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('rg_exclusion_user_id_idx').on(t.userId),
    index('rg_exclusion_user_id_status_idx').on(t.userId, t.status),
    index('rg_exclusion_kind_status_idx').on(t.kind, t.status),
    uniqueIndex('rg_exclusion_active_kind_key')
      .on(t.userId, t.kind)
      .where(sql`${t.status} = 'active'`),
  ],
);

// Monitoring flags surfaced in the back-office. The worker dedupes app-side per
// (userId, flagType, limitType) - no DB unique because limitType is nullable.
export const rgFlag = pgTable(
  'rg_flag',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    flagType: rgFlagType().notNull(),
    limitType: text(),
    // Every insert path (raiseFlag) passes detail explicitly; the DB default is a bare
    // '{}' safety net only, so it's raw SQL rather than a value typed as RgFlagDetail.
    detail: jsonb()
      .$type<RgFlagDetail>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: rgFlagStatus().notNull().default('active'),
    flaggedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('rg_flag_status_flagged_at_idx').on(t.status, t.flaggedAt),
    index('rg_flag_user_id_idx').on(t.userId),
    index('rg_flag_flag_type_idx').on(t.flagType),
  ],
);

export type UserLimit = typeof userLimit.$inferSelect;
export type GeoRule = typeof geoRule.$inferSelect;
export type KycVerification = typeof kycVerification.$inferSelect;
export type RgExclusion = typeof rgExclusion.$inferSelect;
export type RgFlag = typeof rgFlag.$inferSelect;

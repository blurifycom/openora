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
export const kycTriggeredBy = pgEnum('kyc_triggered_by', KYC_TRIGGERED_BY);
export const rgExclusionKind = pgEnum('rg_exclusion_kind', EXCLUSION_KINDS);
export const rgExclusionStatus = pgEnum('rg_exclusion_status', EXCLUSION_STATUSES);
export const rgFlagType = pgEnum('rg_flag_type', RG_FLAG_TYPES);
export const rgFlagStatus = pgEnum('rg_flag_status', RG_FLAG_STATUSES);
export const limitChangeKind = pgEnum('limit_change_kind', LIMIT_CHANGE_KINDS);

// A session-type `user_limit` row is measured in minutes, not money, and carries no real
// currency. It always gets this sentinel rather than NULL, which keeps it participating
// normally in the widened unique index below - Postgres treats every NULL as distinct in
// a unique index, so a NULL session currency would let a player open unlimited duplicate
// session-limit rows, which is exactly the thing this table must never allow. The
// sentinel never reaches the wire (see toDbCurrency/toWireCurrency in rg.service.ts).
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
    // The currency `amount` (and `pendingAmount`) is denominated in. The session-type
    // limit always carries the SESSION_LIMIT_CURRENCY sentinel (see above). A money-type
    // limit set through this platform's currency-aware contract always carries the real
    // ticker the player set - NULL here means only one thing: a row written BEFORE this
    // column existed, whose currency has not been resolved yet. It is resolved lazily,
    // to the player's own currency, and PERSISTED the first time anything reads or writes
    // it (see resolveLimitCurrency/resolveLimitCurrencyInTx in rg.service.ts) rather than
    // backfilled in bulk at migration time: a blanket backfill (eg to USD) would silently
    // redefine what a player's own limit already meant for every currency that isn't USD.
    // All spend/attempted-amount conversion (RgMonitoringService.spendFor,
    // RgLimitGate.check) converts INTO this currency once resolved; an unresolvable
    // currency (no player record) fails the money move closed rather than guessing one.
    currency: text(),
    period: text({ enum: limitPeriods }).notNull(),
    // A player's request to WEAKEN this limit (raise it or drop it), parked here rather
    // than in a table of its own: `(userId, type, period, currency)` is already unique, so
    // a limit can carry at most one open request. `amount` above stays the effective limit
    // the whole time a request is pending - nothing here is ever promoted lazily on read,
    // and the sweep that expires a stale request never touches `amount` either. The
    // only thing that moves a limit upward is the player confirming, in
    // RgSelfServiceService.confirmPendingChange.
    pendingKind: limitChangeKind(),
    // Target value of an `increase`, polymorphic by `type` exactly like amount/minutes
    // above. Both null for a `removal` (there is no target - the row goes away).
    pendingAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }),
    pendingMinutes: integer(),
    // Requested currency for an `increase`, alongside pendingAmount: a player may raise
    // the amount AND change the currency in one request, and both must apply together on
    // confirm. Null for a `removal` (no target) and for a session-type limit (no currency).
    pendingCurrency: text(),
    pendingRequestedAt: timestamp({ withTimezone: true }),
    // When the cool-down has been served and the player may confirm.
    pendingEffectiveAt: timestamp({ withTimezone: true }),
    // When an unconfirmed request lapses and must be filed again from scratch.
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
    // The expiry sweep scans by deadline across every player, not by player.
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
    index('kyc_verification_user_id_created_at_idx').on(t.userId, t.createdAt),
    uniqueIndex('kyc_verification_reference_id_key').on(t.referenceId),
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

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  real,
  decimal,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { KYC_STATUSES } from '@blurifycom/core/contracts';
import { KYC_DOCUMENT_TYPES, KYC_TRIGGERED_BY } from '../contract/enums.js';

export const kycVerificationStatus = pgEnum('kyc_verification_status', KYC_STATUSES);
export const kycTriggeredBy = pgEnum('kyc_triggered_by', KYC_TRIGGERED_BY);

export const userLimit = pgTable(
  'user_limit',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    type: text().notNull(),
    amount: real().notNull(),
    period: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('user_limit_user_id_type_period_key').on(t.userId, t.type, t.period),
    index('user_limit_user_id_idx').on(t.userId),
  ],
);

export const geoRule = pgTable('geo_rule', {
  id: uuid().primaryKey().defaultRandom(),
  countryCode: text().notNull().unique('geo_rule_country_code_unique'),
  action: text().notNull(),
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
    triggeredBy: kycTriggeredBy().notNull(),
    // High-water mark of deposits at the last reverify_threshold fire, so re-KYC triggers
    // once per fresh threshold band rather than on every deposit.
    triggerDeposits: decimal({ precision: 18, scale: 2 }),
    submittedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('kyc_verification_user_id_created_at_idx').on(t.userId, t.createdAt),
    index('kyc_verification_reference_id_idx').on(t.referenceId),
    index('kyc_verification_status_idx').on(t.status),
  ],
);

export type UserLimit = typeof userLimit.$inferSelect;
export type GeoRule = typeof geoRule.$inferSelect;
export type KycVerification = typeof kycVerification.$inferSelect;

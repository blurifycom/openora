import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgTable,
  pgEnum,
  uuid,
  text,
  decimal,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import {
  CONTRIBUTION_PERCENT_PRECISION,
  CONTRIBUTION_PERCENT_SCALE,
  MONEY_PRECISION,
  MONEY_SCALE,
  BONUS_FORFEIT_REASONS,
  BONUS_GRANT_ENTRY_TYPES,
  BONUS_GRANT_SOURCES,
  BONUS_GRANT_STATUSES,
  PROMO_OFFER_STATUSES,
  REFERENCE_EDGE_PRECISION,
  REFERENCE_EDGE_SCALE,
  WAGER_CONTRIBUTION_MODES,
  type BonusForfeitReason,
  type BonusGrantSource,
  type BonusGrantEntryType,
  type BonusGrantStatus,
  type BonusGrantTerms,
  type PromoOfferStatus,
  type WagerContributionMode,
} from '@openora/core/contracts';
import {
  WAGER_WEIGHT_SCOPES,
  type PromoOfferRules,
  type StakeWagerInputs,
  type WagerWeightScope,
} from '../contract/index.js';
import type { WagerWeightRow } from '../shared/wagering-weight.js';

export const promoWeightScopeEnum = pgEnum('promo_weight_scope', WAGER_WEIGHT_SCOPES);
export const promoContributionModeEnum = pgEnum(
  'promo_contribution_mode',
  WAGER_CONTRIBUTION_MODES,
);

export const promoWeightProfile = pgTable(
  'promo_weight_profile',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull().unique(),
    contributionMode: promoContributionModeEnum()
      .$type<WagerContributionMode>()
      .notNull()
      .default('flat'),
    referenceEdge: decimal({ precision: REFERENCE_EDGE_PRECISION, scale: REFERENCE_EDGE_SCALE }),
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      'promo_weight_profile_reference_edge_matches_mode',
      sql`(${t.contributionMode} = 'house_edge') = (${t.referenceEdge} is not null) AND (${t.referenceEdge} is null OR (${t.referenceEdge} > 0 AND ${t.referenceEdge} <= 1))`,
    ),
  ],
);

export const promoWeight = pgTable(
  'promo_weight',
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => promoWeightProfile.id, { onDelete: 'cascade' }),
    scope: promoWeightScopeEnum().$type<WagerWeightScope>().notNull(),
    scopeRef: text(),
    contributionPercent: decimal({
      precision: CONTRIBUTION_PERCENT_PRECISION,
      scale: CONTRIBUTION_PERCENT_SCALE,
    }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('promo_weight_profile_id_scope_scope_ref_idx').on(t.profileId, t.scope, t.scopeRef),
    uniqueIndex('promo_weight_profile_id_default_idx')
      .on(t.profileId)
      .where(sql`${t.scope} = 'default'`),
    check(
      'promo_weight_contribution_percent_range',
      sql`${t.contributionPercent} >= 0 AND ${t.contributionPercent} <= 100`,
    ),
  ],
);

export type GrantTermsSnapshot = BonusGrantTerms & {
  weights: WagerWeightRow[];
  dustThreshold?: string;
  contributionMode?: WagerContributionMode;
  referenceEdge?: string;
  weightProfileVersion?: number;
};

export const promoOfferStatusEnum = pgEnum('promo_offer_status', PROMO_OFFER_STATUSES);

export const promoOffer = pgTable(
  'promo_offer',
  {
    id: uuid().primaryKey().defaultRandom(),
    key: text().notNull().unique(),
    name: text().notNull(),
    status: promoOfferStatusEnum().$type<PromoOfferStatus>().notNull().default('draft'),
    currency: text().notNull(),
    matchPercent: decimal({
      precision: CONTRIBUTION_PERCENT_PRECISION,
      scale: CONTRIBUTION_PERCENT_SCALE,
    }).notNull(),
    maxGrantAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    minDeposit: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    terms: jsonb().$type<BonusGrantTerms>().notNull(),
    rules: jsonb().$type<PromoOfferRules>().notNull(),
    requiresOptIn: boolean().notNull().default(true),
    validFrom: timestamp({ withTimezone: true }),
    validUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('promo_offer_status_valid_from_valid_until_idx').on(t.status, t.validFrom, t.validUntil),
    check(
      'promo_offer_match_percent_positive',
      sql`${t.matchPercent} > 0 AND ${t.maxGrantAmount} > 0 AND ${t.minDeposit} >= 0`,
    ),
  ],
);

export const promoOptIn = pgTable(
  'promo_opt_in',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    offerId: uuid()
      .notNull()
      .references(() => promoOffer.id, { onDelete: 'restrict' }),
    accumulatedDeposit: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    grantId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('promo_opt_in_user_id_offer_id_idx').on(t.userId, t.offerId)],
);

export const promoOptInDeposit = pgTable(
  'promo_opt_in_deposit',
  {
    id: uuid().primaryKey().defaultRandom(),
    optInId: uuid()
      .notNull()
      .references(() => promoOptIn.id, { onDelete: 'cascade' }),
    transactionId: uuid().notNull(),
    amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('promo_opt_in_deposit_opt_in_id_transaction_id_idx').on(t.optInId, t.transactionId),
  ],
);

export const promoGrantStatusEnum = pgEnum('promo_grant_status', BONUS_GRANT_STATUSES);
export const promoGrantSourceEnum = pgEnum('promo_grant_source', BONUS_GRANT_SOURCES);
export const promoForfeitReasonEnum = pgEnum('promo_forfeit_reason', BONUS_FORFEIT_REASONS);

export const promoGrant = pgTable(
  'promo_grant',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    currency: text().notNull(),
    source: promoGrantSourceEnum().$type<BonusGrantSource>().notNull(),
    sourceRef: text().notNull(),
    offerId: uuid(),
    terms: jsonb().$type<GrantTermsSnapshot>().notNull(),
    grantedAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    bonusBalance: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    wageringRequired: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    wageringProgress: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    unlinkedCash: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    linkedCash: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull().default('0'),
    status: promoGrantStatusEnum().$type<BonusGrantStatus>().notNull().default('active'),
    forfeitReason: promoForfeitReasonEnum().$type<BonusForfeitReason>(),
    forfeitedBy: uuid(),
    forfeitNote: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    activatedAt: timestamp({ withTimezone: true }),
    closedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('promo_grant_user_id_source_source_ref_idx').on(t.userId, t.source, t.sourceRef),
    uniqueIndex('promo_grant_id_user_id_currency_idx').on(t.id, t.userId, t.currency),
    index('promo_grant_user_id_currency_expires_at_idx')
      .on(t.userId, t.currency, t.expiresAt)
      .where(sql`${t.status} in ('pending', 'active')`),
    index('promo_grant_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} in ('pending', 'active')`),
    index('promo_grant_user_id_created_at_idx').on(t.userId, t.createdAt, t.id),
    index('promo_grant_activated_at_idx')
      .on(t.activatedAt)
      .where(sql`${t.activatedAt} is not null`),
    index('promo_grant_closed_at_idx')
      .on(t.closedAt)
      .where(sql`${t.closedAt} is not null`),
    index('promo_grant_created_at_idx').on(t.createdAt, t.id),
    check('promo_grant_bonus_balance_non_negative', sql`${t.bonusBalance} >= 0`),
    check(
      'promo_grant_cash_buckets_non_negative',
      sql`${t.unlinkedCash} >= 0 AND ${t.linkedCash} >= 0`,
    ),
    check(
      'promo_grant_progress_within_requirement',
      sql`${t.wageringProgress} >= 0 AND ${t.wageringProgress} <= ${t.wageringRequired}`,
    ),
    check(
      'promo_grant_forfeit_reason_matches_status',
      sql`(${t.status} = 'forfeited') = (${t.forfeitReason} is not null)`,
    ),
  ],
);

export const promoGrantEntryTypeEnum = pgEnum('promo_grant_entry_type', BONUS_GRANT_ENTRY_TYPES);

export const promoGrantEntry = pgTable(
  'promo_grant_entry',
  {
    id: uuid().primaryKey().defaultRandom(),
    grantId: uuid().notNull(),
    userId: uuid().notNull(),
    currency: text().notNull(),
    type: promoGrantEntryTypeEnum().$type<BonusGrantEntryType>().notNull(),
    bonusAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    realAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull().default('0'),
    unlinkedAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    linkedAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    wageringDelta: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    wagerInputs: jsonb().$type<StakeWagerInputs>(),
    balanceAfter: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    externalRoundId: text(),
    providerName: text(),
    walletTransactionId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.grantId, t.userId, t.currency],
      foreignColumns: [promoGrant.id, promoGrant.userId, promoGrant.currency],
    }).onDelete('restrict'),
    index('promo_grant_entry_user_id_currency_provider_name_external_round_id_idx')
      .on(t.userId, t.currency, t.providerName, t.externalRoundId)
      .where(sql`${t.externalRoundId} is not null`),
    index('promo_grant_entry_grant_id_created_at_idx').on(t.grantId, t.createdAt),
    index('promo_grant_entry_user_id_created_at_idx').on(t.userId, t.createdAt),
  ],
);

export type PromoGrant = typeof promoGrant.$inferSelect;
export type PromoGrantEntry = typeof promoGrantEntry.$inferSelect;
export type PromoOffer = typeof promoOffer.$inferSelect;
export type PromoOptIn = typeof promoOptIn.$inferSelect;
export type PromoOptInDeposit = typeof promoOptInDeposit.$inferSelect;
export type PromoWeightProfile = typeof promoWeightProfile.$inferSelect;
export type PromoWeight = typeof promoWeight.$inferSelect;

export const promoGrantRound = pgTable(
  'promo_grant_round',
  {
    id: uuid().primaryKey().defaultRandom(),
    grantId: uuid().notNull(),
    userId: uuid().notNull(),
    currency: text().notNull(),
    providerName: text().notNull(),
    externalRoundId: text().notNull(),
    progressPending: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check('promo_grant_round_progress_pending_non_negative', sql`${t.progressPending} >= 0`),
    foreignKey({
      columns: [t.grantId, t.userId, t.currency],
      foreignColumns: [promoGrant.id, promoGrant.userId, promoGrant.currency],
    }).onDelete('restrict'),
    uniqueIndex('promo_grant_round_grant_id_provider_name_external_round_id_idx').on(
      t.grantId,
      t.providerName,
      t.externalRoundId,
    ),
    index('promo_grant_round_grant_id_open_idx')
      .on(t.grantId)
      .where(sql`${t.settledAt} is null`),
    index('promo_grant_round_round_key_idx').on(
      t.userId,
      t.currency,
      t.providerName,
      t.externalRoundId,
    ),
  ],
);

export type PromoGrantRound = typeof promoGrantRound.$inferSelect;

export const promoGrantDeposit = pgTable('promo_grant_deposit', {
  transactionId: uuid().primaryKey(),
  grantId: uuid()
    .notNull()
    .references(() => promoGrant.id, { onDelete: 'restrict' }),
  amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

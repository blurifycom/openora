import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgTable,
  pgEnum,
  uuid,
  text,
  decimal,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  CONTRIBUTION_PERCENT_PRECISION,
  CONTRIBUTION_PERCENT_SCALE,
  MONEY_PRECISION,
  MONEY_SCALE,
  PROMO_OFFER_STATUSES,
  type BonusForfeitReason,
  type BonusGrantEntryType,
  type BonusGrantSource,
  type BonusGrantStatus,
  type BonusGrantTerms,
  type PromoOfferStatus,
} from '@openora/core/contracts';
import {
  BONUS_FORFEIT_REASONS,
  BONUS_GRANT_ENTRY_TYPES,
  BONUS_GRANT_SOURCES,
  BONUS_GRANT_STATUSES,
  WAGER_WEIGHT_SCOPES,
  type PromoOfferRules,
  type WagerWeightScope,
} from '../contract/index.js';
import type { WagerWeightRow } from '../shared/wagering-weight.js';

export const promoWeightScopeEnum = pgEnum('promo_weight_scope', WAGER_WEIGHT_SCOPES);

/**
 * A named set of wagering weights. An offer points at one, so two offers can count the same
 * game differently without duplicating every row.
 */
export const promoWeightProfile = pgTable('promo_weight_profile', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * How much a bet matching `scope`/`scopeRef` contributes toward a wagering requirement.
 * Resolution is most-specific-first: game, category, product, then the profile default.
 */
export const promoWeight = pgTable(
  'promo_weight',
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid()
      .notNull()
      .references(() => promoWeightProfile.id, { onDelete: 'cascade' }),
    scope: promoWeightScopeEnum().$type<WagerWeightScope>().notNull(),
    /** Null only on the `default` scope, which is the profile's catch-all and targets nothing. */
    scopeRef: text(),
    contributionPercent: decimal({
      precision: CONTRIBUTION_PERCENT_PRECISION,
      scale: CONTRIBUTION_PERCENT_SCALE,
    }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('promo_weight_profile_id_scope_scope_ref_idx').on(t.profileId, t.scope, t.scopeRef),
    // Postgres does not treat two nulls as duplicates, so the index above would let a profile
    // hold two `default` rows and resolution would then depend on row order.
    uniqueIndex('promo_weight_profile_id_default_idx')
      .on(t.profileId)
      .where(sql`${t.scope} = 'default'`),
    // A weight above 100 credits a bet for more than it was worth and releases a bonus early,
    // which cannot be undone. The bound belongs where no caller can route around it.
    check(
      'promo_weight_contribution_percent_range',
      sql`${t.contributionPercent} >= 0 AND ${t.contributionPercent} <= 100`,
    ),
  ],
);

/**
 * The terms as stored on a grant: the caller's terms plus the weight rows the profile held at
 * grant time. Wagering is scored from `weights`, never from the live profile.
 */
export type GrantTermsSnapshot = BonusGrantTerms & { weights: WagerWeightRow[] };

export const promoOfferStatusEnum = pgEnum('promo_offer_status', PROMO_OFFER_STATUSES);

/**
 * What an operator is offering. A single mutable row: a grant snapshots the terms it was created
 * under, so editing an offer cannot reach a bonus a player already holds and the row needs no
 * version history to make that true.
 */
export const promoOffer = pgTable(
  'promo_offer',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Stable handle an operator names the offer by, and what a player opts into. */
    key: text().notNull().unique(),
    name: text().notNull(),
    status: promoOfferStatusEnum().$type<PromoOfferStatus>().notNull().default('draft'),
    currency: text().notNull(),
    /** Percentage of the qualifying deposit granted as bonus, `numeric(5,2)` like a weight. */
    matchPercent: decimal({
      precision: CONTRIBUTION_PERCENT_PRECISION,
      scale: CONTRIBUTION_PERCENT_SCALE,
    }).notNull(),
    maxGrantAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    minDeposit: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    terms: jsonb().$type<BonusGrantTerms>().notNull(),
    rules: jsonb().$type<PromoOfferRules>().notNull(),
    /** Absent from a player's list until they take it; otherwise it applies to any deposit. */
    requiresOptIn: boolean().notNull().default(false),
    validFrom: timestamp({ withTimezone: true }),
    validUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The live-offer read. The window is filtered in the service, where the same predicate
    // answers both "show me the offers" and "credit this deposit".
    index('promo_offer_status_valid_from_valid_until_idx').on(t.status, t.validFrom, t.validUntil),
    check(
      'promo_offer_match_percent_positive',
      sql`${t.matchPercent} > 0 AND ${t.maxGrantAmount} > 0 AND ${t.minDeposit} >= 0`,
    ),
  ],
);

/**
 * A player's claim on an offer, and the deposits they have put toward its minimum. One row per
 * player per offer: taking an offer twice is the same claim, and the deposits accumulate on it
 * so a player who deposits under the minimum twice still qualifies.
 */
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
    /** Set once the deposits met the minimum and the grant was created. */
    grantId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('promo_opt_in_user_id_offer_id_idx').on(t.userId, t.offerId)],
);

/**
 * Which deposits have already been counted toward which claim. The durable guard the accumulator
 * needs: jobs are at-least-once, and a redelivered deposit that adds itself to the running total
 * a second time turns a below-minimum deposit into a full-cap bonus.
 */
export const promoOptInDeposit = pgTable(
  'promo_opt_in_deposit',
  {
    id: uuid().primaryKey().defaultRandom(),
    optInId: uuid()
      .notNull()
      .references(() => promoOptIn.id, { onDelete: 'cascade' }),
    /** The wallet transaction that was counted. Cross-module id, no FK. */
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

/**
 * One bonus a player holds. The grant row IS the bonus balance: bonus funds never enter
 * `wallet_balance`, so a withdrawal cannot reach them and reconciliation never sees money that
 * was never deposited. They cross into the real balance exactly once, at conversion.
 *
 * `terms` is a snapshot, never a lookup. Editing an offer must not change a bonus already
 * granted, which is the one rule the configuration surface has to obey.
 */
export const promoGrant = pgTable(
  'promo_grant',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Cross-module id, no FK (module-boundary rule).
    userId: uuid().notNull(),
    currency: text().notNull(),
    source: promoGrantSourceEnum().$type<BonusGrantSource>().notNull(),
    // The deposit transaction, the `<mechanic>:<utc-day>` job key, the race id.
    sourceRef: text().notNull(),
    offerId: uuid(),
    terms: jsonb().$type<GrantTermsSnapshot>().notNull(),
    grantedAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    // Bonus funds still on this grant. Spent by a bet, topped up by a bonus-funded win,
    // zeroed by conversion, expiry or forfeiture.
    bonusBalance: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    wageringRequired: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    wageringProgress: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    status: promoGrantStatusEnum().$type<BonusGrantStatus>().notNull().default('active'),
    forfeitReason: promoForfeitReasonEnum().$type<BonusForfeitReason>(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    // Null while the grant is still `pending` and nothing has been credited.
    activatedAt: timestamp({ withTimezone: true }),
    // Set once the grant reaches any terminal status; `status` says which one.
    closedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The idempotency guard. A replayed deposit or a re-run daily job hits this, not a
    // read-then-write check that two concurrent callers would both pass.
    uniqueIndex('promo_grant_user_id_source_source_ref_idx').on(t.userId, t.source, t.sourceRef),
    // Attribution on every bet: the live grants a player holds in one currency, earliest expiry
    // first. Partial, because a terminal grant is never consumed again and long-term they are
    // almost the whole table.
    index('promo_grant_user_id_currency_expires_at_idx')
      .on(t.userId, t.currency, t.expiresAt)
      .where(sql`${t.status} in ('pending', 'active')`),
    // The expiry sweep, over live rows only.
    index('promo_grant_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active'`),
    // Money invariants the engine must never be able to break, held where no caller can route
    // around them: a bonus balance cannot go negative and progress cannot pass its requirement.
    check('promo_grant_bonus_balance_non_negative', sql`${t.bonusBalance} >= 0`),
    check(
      'promo_grant_progress_within_requirement',
      sql`${t.wageringProgress} >= 0 AND ${t.wageringProgress} <= ${t.wageringRequired}`,
    ),
    check(
      'promo_grant_forfeit_reason_requires_forfeited',
      sql`${t.forfeitReason} is null or ${t.status} = 'forfeited'`,
    ),
  ],
);

export const promoGrantEntryTypeEnum = pgEnum('promo_grant_entry_type', BONUS_GRANT_ENTRY_TYPES);

/**
 * The bonus ledger: one row per movement on a grant, append-only. `wallet_transaction` stays the
 * real-money ledger; a movement that never touches the real balance belongs here, and the spec
 * still requires it be recorded immutably.
 *
 * `bonusAmount` is a signed delta, so the sum of a grant's entries always equals its
 * `bonus_balance`. If that identity ever breaks, money moved outside the ledger.
 *
 * `userId` is denormalised from the grant so the win-attribution lookup by round is one indexed
 * read with no join.
 */
export const promoGrantEntry = pgTable(
  'promo_grant_entry',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Same module, so a real FK. Restrict, not cascade: a ledger a single DELETE can erase is
    // not a ledger, and a grant that has to go away gets a forfeit or expire entry instead.
    grantId: uuid()
      .notNull()
      .references(() => promoGrant.id, { onDelete: 'restrict' }),
    userId: uuid().notNull(),
    // Denormalised from the grant so the ledger reads as money on its own terms.
    currency: text().notNull(),
    type: promoGrantEntryTypeEnum().$type<BonusGrantEntryType>().notNull(),
    // Signed: negative on a stake, positive on a grant or a win, negative on a conversion.
    bonusAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    // The real-money half of the same bet. The win split needs both sides of the stake.
    realAmount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull().default('0'),
    wageringDelta: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE })
      .notNull()
      .default('0'),
    balanceAfter: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    // The provider round, on the movements that have one. How a win finds its funding grant.
    externalRoundId: text(),
    // Cross-module id, no FK (module-boundary rule).
    walletTransactionId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Win and reversal attribution: find this round's stake rows without joining the grant.
    index('promo_grant_entry_user_id_external_round_id_idx')
      .on(t.userId, t.externalRoundId)
      .where(sql`${t.externalRoundId} is not null`),
    // A grant's own history, oldest first.
    index('promo_grant_entry_grant_id_created_at_idx').on(t.grantId, t.createdAt),
  ],
);

export type PromoGrant = typeof promoGrant.$inferSelect;
export type PromoGrantEntry = typeof promoGrantEntry.$inferSelect;
export type PromoOffer = typeof promoOffer.$inferSelect;
export type PromoOptIn = typeof promoOptIn.$inferSelect;
export type PromoOptInDeposit = typeof promoOptInDeposit.$inferSelect;
export type PromoWeightProfile = typeof promoWeightProfile.$inferSelect;
export type PromoWeight = typeof promoWeight.$inferSelect;

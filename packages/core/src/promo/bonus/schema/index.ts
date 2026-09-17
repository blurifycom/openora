import { sql } from 'drizzle-orm';
import {
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
  type BonusGrantSource,
  type BonusGrantTerms,
} from '@openora/core/contracts';
import {
  BONUS_FORFEIT_REASONS,
  BONUS_GRANT_SOURCES,
  BONUS_GRANT_STATUSES,
  WAGER_WEIGHT_SCOPES,
  type BonusForfeitReason,
  type BonusGrantStatus,
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
    uniqueIndex().on(t.userId, t.source, t.sourceRef),
    // FIFO consumption order and the balance read.
    index().on(t.userId, t.currency, t.status, t.createdAt),
    // The expiry sweep, over live rows only.
    index()
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type PromoGrant = typeof promoGrant.$inferSelect;
export type PromoWeightProfile = typeof promoWeightProfile.$inferSelect;
export type PromoWeight = typeof promoWeight.$inferSelect;

import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  pgEnum,
  uuid,
  text,
  decimal,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  CONTRIBUTION_PERCENT_PRECISION,
  CONTRIBUTION_PERCENT_SCALE,
} from '@openora/core/contracts';
import { WAGER_WEIGHT_SCOPES, type WagerWeightScope } from '../contract/index.js';

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

export type PromoWeightProfile = typeof promoWeightProfile.$inferSelect;
export type PromoWeight = typeof promoWeight.$inferSelect;

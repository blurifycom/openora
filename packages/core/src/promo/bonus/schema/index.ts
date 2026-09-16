import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, text, decimal, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { MONEY_PRECISION, MONEY_SCALE } from '@openora/core/contracts';
import { WAGER_WEIGHT_SCOPES, type WagerWeightScope } from '../contract/index.js';

// Drizzle tables owned by the Bonus module.
// Rules:
//   - Column names come from the key via the snake_case casing config - never pass
//     an explicit string (lint: drizzle-snake-case).
//   - Timestamps are always `withTimezone` (lint: no-naive-timestamp).
//   - Do NOT add FK references to tables owned by another domain - reference by id.

export const wagerWeightScopes = WAGER_WEIGHT_SCOPES;

export const promoWeightScopeEnum = pgEnum('promo_weight_scope', WAGER_WEIGHT_SCOPES);

/**
 * A named set of wagering weights. An offer points at one, so two offers can count the same
 * game differently without duplicating every row.
 */
export const promoWeightProfile = pgTable('promo_weight_profile', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
    // Null only on the `default` scope, which is the profile's catch-all and targets nothing.
    scopeRef: text(),
    contributionPercent: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One weight per target.
    uniqueIndex().on(t.profileId, t.scope, t.scopeRef),
    // The default row carries a null `scopeRef`, and Postgres does not treat two nulls as
    // duplicates, so the index above would let a profile hold two defaults and resolution
    // would then depend on row order. This one says it directly: at most one default.
    uniqueIndex()
      .on(t.profileId)
      .where(sql`${t.scope} = 'default'`),
  ],
);

export type PromoWeightProfile = typeof promoWeightProfile.$inferSelect;
export type PromoWeight = typeof promoWeight.$inferSelect;

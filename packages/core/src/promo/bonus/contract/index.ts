import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@openora/core/contracts';

// Canonical request/response shapes for the Bonus module. This is the
// single source of truth - the router validates against it, live OpenAPI + the typed
// client are emitted from it. Derive related shapes with .pick()/.omit()/.extend()
// rather than re-typing fields. Promote anything shared across domains to
// @openora/core/contracts. This dir is isomorphic: Zod + @openora/core/contracts only.

/**
 * What a weight row targets, most specific first. A bet resolves against a profile in this
 * order and takes the first row that matches; `default` is the profile's catch-all.
 */
export const WAGER_WEIGHT_SCOPES = ['game', 'category', 'product', 'default'] as const;
export type WagerWeightScope = (typeof WAGER_WEIGHT_SCOPES)[number];
export const WagerWeightScopeSchema = z.enum(WAGER_WEIGHT_SCOPES);

/**
 * A weight as a percentage of the stake. Zero excludes a product or game from wagering
 * entirely; above 100 would count a bet for more than it was worth, so it is rejected.
 */
export const ContributionPercentSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string')
  .refine((v) => Number(v) <= 100, 'must not exceed 100');

export const WagerWeightSchema = z.object({
  id: UuidSchema,
  profileId: UuidSchema,
  scope: WagerWeightScopeSchema,
  /** The game id, category slug or product this row targets; null on the profile default. */
  scopeRef: z.string().min(1).nullable(),
  contributionPercent: ContributionPercentSchema,
  createdAt: TimestampSchema,
});

export type WagerWeight = z.infer<typeof WagerWeightSchema>;

export const WagerWeightProfileSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(120),
  createdAt: TimestampSchema,
});

export type WagerWeightProfile = z.infer<typeof WagerWeightProfileSchema>;

export const bonusContract = {};

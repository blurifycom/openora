import * as z from 'zod';
import { ContributionPercentSchema, TimestampSchema, UuidSchema } from '@openora/core/contracts';

/**
 * What a weight row targets, most specific first. A bet resolves against a profile in this
 * order and takes the first row that matches; `default` is the profile's catch-all.
 */
export const WAGER_WEIGHT_SCOPES = ['game', 'category', 'product', 'default'] as const;
export const WagerWeightScopeSchema = z.enum(WAGER_WEIGHT_SCOPES);
export type WagerWeightScope = z.infer<typeof WagerWeightScopeSchema>;

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
  updatedAt: TimestampSchema,
});

export type WagerWeightProfile = z.infer<typeof WagerWeightProfileSchema>;

export const bonusContract = {};

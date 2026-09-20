import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  BONUS_FORFEIT_REASONS,
  BONUS_GRANT_ENTRY_TYPES,
  BONUS_GRANT_SOURCES,
  BONUS_GRANT_STATUSES,
  BonusGrantSourceSchema,
  BonusGrantStatusSchema,
  BonusForfeitReasonSchema,
  ContributionPercentSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  PageQuerySchema,
  paginated,
  TimestampSchema,
  UuidSchema,
} from '@openora/core/contracts';

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

/**
 * A bonus as its holder sees it. Money is a decimal string, never a number: a bonus balance at
 * eighteen decimal places does not survive a round trip through a JSON number.
 */
export const PlayerGrantSchema = z.object({
  id: UuidSchema,
  currency: CurrencyTickerSchema,
  source: BonusGrantSourceSchema,
  status: BonusGrantStatusSchema,
  grantedAmount: MoneyAmountSchema,
  bonusBalance: MoneyAmountSchema,
  wageringRequired: MoneyAmountSchema,
  wageringProgress: MoneyAmountSchema,
  forfeitReason: BonusForfeitReasonSchema.nullable(),
  expiresAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export type PlayerGrant = z.infer<typeof PlayerGrantSchema>;

export const ListPlayerGrantsInputSchema = z.object({
  ...PageQuerySchema.shape,
  /** Absent means every status; a terminal grant is never purged, so the history only grows. */
  status: BonusGrantStatusSchema.optional(),
});

export {
  BONUS_FORFEIT_REASONS,
  BONUS_GRANT_ENTRY_TYPES,
  BONUS_GRANT_SOURCES,
  BONUS_GRANT_STATUSES,
  BonusGrantSourceSchema,
};

export const bonusContract = {
  grants: {
    list: oc
      .route({ method: 'GET', path: '/promo/grants' })
      .input(ListPlayerGrantsInputSchema)
      .output(paginated(PlayerGrantSchema)),

    get: oc
      .route({ method: 'GET', path: '/promo/grants/{id}' })
      .input(z.object({ id: UuidSchema }))
      .output(PlayerGrantSchema),
  },
};

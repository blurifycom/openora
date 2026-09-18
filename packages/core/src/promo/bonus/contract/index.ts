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
  CountryCodeSchema,
  MoneyAmountSchema,
  PROMO_OFFER_STATUSES,
  PageQuerySchema,
  PromoOfferStatusSchema,
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
 * Who an offer is for. Kept as jsonb on the row rather than as columns: every one of these is a
 * predicate an operator turns on or off, and a new one should not cost a migration.
 */
export const PromoOfferRulesSchema = z.object({
  /** Only the player's first confirmed deposit qualifies. */
  firstDepositOnly: z.boolean().default(false),
  /** Players resident in these countries are not offered it. */
  excludedCountries: z.array(CountryCodeSchema).default([]),
});

export type PromoOfferRules = z.infer<typeof PromoOfferRulesSchema>;

export const BonusGrantTermsSchema = z.object({
  wageringMultiplier: MoneyAmountSchema,
  expiryDays: z.number().int().positive().max(365),
  weightProfileId: UuidSchema.optional(),
});

/** An offer as an admin configures it. */
export const PromoOfferSchema = z.object({
  id: UuidSchema,
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  status: PromoOfferStatusSchema,
  currency: CurrencyTickerSchema,
  matchPercent: ContributionPercentSchema,
  maxGrantAmount: MoneyAmountSchema,
  minDeposit: MoneyAmountSchema,
  terms: BonusGrantTermsSchema,
  rules: PromoOfferRulesSchema,
  requiresOptIn: z.boolean(),
  validFrom: TimestampSchema.nullable(),
  validUntil: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type PromoOffer = z.infer<typeof PromoOfferSchema>;

export const CreatePromoOfferInputSchema = PromoOfferSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: PromoOfferStatusSchema.default('draft'),
  rules: PromoOfferRulesSchema.default({ firstDepositOnly: false, excludedCountries: [] }),
  requiresOptIn: z.boolean().default(false),
  validFrom: TimestampSchema.nullable().default(null),
  validUntil: TimestampSchema.nullable().default(null),
});

export type CreatePromoOfferInput = z.infer<typeof CreatePromoOfferInputSchema>;

export const UpdatePromoOfferInputSchema = CreatePromoOfferInputSchema.partial()
  .omit({ key: true })
  .extend({ id: UuidSchema });

export type UpdatePromoOfferInput = z.infer<typeof UpdatePromoOfferInputSchema>;

/** What a player sees of an offer: the deal, never the operator's weighting. */
export const PlayerOfferSchema = PromoOfferSchema.pick({
  id: true,
  key: true,
  name: true,
  currency: true,
  matchPercent: true,
  maxGrantAmount: true,
  minDeposit: true,
  requiresOptIn: true,
  validUntil: true,
}).extend({
  wageringMultiplier: MoneyAmountSchema,
  /** The player already took this one; deposits are counting toward its minimum. */
  optedIn: z.boolean(),
  /** What their deposits have put toward the minimum so far. */
  accumulatedDeposit: MoneyAmountSchema,
});

export type PlayerOffer = z.infer<typeof PlayerOfferSchema>;

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
  PROMO_OFFER_STATUSES,
  BonusGrantSourceSchema,
};

export const bonusContract = {
  offers: {
    list: oc.route({ method: 'GET', path: '/promo/offers' }).output(z.array(PlayerOfferSchema)),

    optIn: oc
      .route({ method: 'POST', path: '/promo/offers/{id}/opt-in' })
      .input(z.object({ id: UuidSchema }))
      .output(PlayerOfferSchema),
  },

  admin: {
    offers: {
      list: oc
        .route({ method: 'GET', path: '/backoffice/promo/offers' })
        .input(z.object({ ...PageQuerySchema.shape, status: PromoOfferStatusSchema.optional() }))
        .output(z.array(PromoOfferSchema)),

      create: oc
        .route({ method: 'POST', path: '/backoffice/promo/offers' })
        .input(CreatePromoOfferInputSchema)
        .output(PromoOfferSchema),

      update: oc
        .route({ method: 'PATCH', path: '/backoffice/promo/offers/{id}' })
        .input(UpdatePromoOfferInputSchema)
        .output(PromoOfferSchema),
    },
  },

  grants: {
    list: oc
      .route({ method: 'GET', path: '/promo/grants' })
      .input(ListPlayerGrantsInputSchema)
      .output(z.array(PlayerGrantSchema)),

    get: oc
      .route({ method: 'GET', path: '/promo/grants/{id}' })
      .input(z.object({ id: UuidSchema }))
      .output(PlayerGrantSchema),
  },
};

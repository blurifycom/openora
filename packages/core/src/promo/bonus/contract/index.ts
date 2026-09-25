import { eventIterator, oc } from '@orpc/contract';
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
  PROMO_OFFER_STATUSES,
  PageQuerySchema,
  paginated,
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

/** A profile with the rows that score a bet against it. */
export const WagerWeightProfileDetailSchema = WagerWeightProfileSchema.extend({
  weights: z.array(WagerWeightSchema.omit({ profileId: true })),
});

export type WagerWeightProfileDetail = z.infer<typeof WagerWeightProfileDetailSchema>;

export const CreateWagerWeightProfileInputSchema = z.object({
  name: z.string().min(1).max(120),
});

export type CreateWagerWeightProfileInput = z.infer<typeof CreateWagerWeightProfileInputSchema>;

/**
 * The whole row set, replaced in one call. A per-row surface would let an operator save half a
 * profile, and a bet resolving against a half-saved profile scores at whatever happens to be
 * there. A `default` row carries no reference; every other scope needs one.
 */
export const SetWagerWeightsInputSchema = z.object({
  id: UuidSchema,
  weights: z
    .array(
      z.object({
        scope: WagerWeightScopeSchema,
        scopeRef: z.string().min(1).nullable(),
        contributionPercent: ContributionPercentSchema,
      }),
    )
    .max(500)
    .refine(
      (rows) => rows.every((r) => (r.scope === 'default') === (r.scopeRef === null)),
      'a default row carries no reference, and every other scope needs one',
    )
    .refine(
      (rows) => new Set(rows.map((r) => `${r.scope}:${r.scopeRef ?? ''}`)).size === rows.length,
      'two rows target the same scope and reference',
    ),
});

export type SetWagerWeightsInput = z.infer<typeof SetWagerWeightsInputSchema>;

/**
 * Who an offer is for, and the small per-offer knobs a mechanic needs that core has no grant
 * shape for. Kept as jsonb on the row rather than as columns: every one of these is a predicate
 * or a setting an operator turns on, off or tunes, and a new one should not cost a migration -
 * which is why a rule with no way to answer it yet is absent rather than present and never
 * firing.
 */
export const PromoOfferRulesSchema = z.object({
  /** Only the player's first confirmed deposit qualifies. */
  firstDepositOnly: z.boolean().default(false),
  /**
   * Free spins a grant of this offer entitles the player to. No provider-crediting API exists
   * yet, so a job sets these pending on grant rather than never asking for a count at all -
   * absent means this offer grants no spins.
   */
  freeSpins: z.number().int().positive().optional(),
  /**
   * How many days a period-close job (e.g. a net-loss cashback sweep) looks back. Absent means
   * the job's own default period.
   */
  periodDays: z.number().int().positive().optional(),
});

export type PromoOfferRules = z.infer<typeof PromoOfferRulesSchema>;

export const BonusGrantTermsSchema = z.object({
  wageringMultiplier: MoneyAmountSchema,
  expiryDays: z.number().int().positive().max(365),
  weightProfileId: UuidSchema.optional(),
  /** Largest single stake while the grant is active. Absent or null for no limit. */
  maxBet: MoneyAmountSchema.nullable().optional(),
  /** Cap on conversion as a multiple of the granted amount. Absent or null for no cap. */
  maxWinMultiplier: MoneyAmountSchema.nullable().optional(),
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
  rules: PromoOfferRulesSchema.default({ firstDepositOnly: false }),
  requiresOptIn: z.boolean().default(false),
  validFrom: TimestampSchema.nullable().default(null),
  validUntil: TimestampSchema.nullable().default(null),
});

export type CreatePromoOfferInput = z.infer<typeof CreatePromoOfferInputSchema>;

/**
 * Built from the row shape rather than from `CreatePromoOfferInputSchema`. `.partial()` makes a
 * field optional but leaves a `.default()` on it intact, so partialling the create schema would
 * have filled every omitted field with its create-time default: a PATCH that renamed a live offer
 * would drop it back to `draft`, and one that paused an opt-in, first-deposit-only offer would
 * clear both rules, so re-activating it matched every depositor's deposit.
 */
export const UpdatePromoOfferInputSchema = PromoOfferSchema.omit({
  id: true,
  key: true,
  createdAt: true,
  updatedAt: true,
})
  .partial()
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
  /** The offer this bonus came from, so a client can show its state on that offer's card. */
  offerId: UuidSchema.nullable(),
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

export const AdminGrantSchema = PlayerGrantSchema.extend({
  userId: UuidSchema,
  sourceRef: z.string(),
});

export type AdminGrant = z.infer<typeof AdminGrantSchema>;

/**
 * A hand-issued forfeiture is always recorded as `admin`; the reason is not the caller's to pick.
 * The vocabulary also carries `self_exclusion`, `account_closed` and the two the product has not
 * scheduled, and an admin able to file their own action as a responsible-gambling one puts a
 * false statement in the record a regulator reads. The note is where the case goes.
 */
export const ForfeitGrantInputSchema = z.object({
  id: UuidSchema,
  note: z.string().trim().min(10).max(500),
});

/**
 * A player's bonus position in one currency. There is no balance table: the figures are the sum
 * over their active grants, which is the only place the funds exist.
 */
export const BonusBalanceSchema = z.object({
  currency: CurrencyTickerSchema,
  bonus: MoneyAmountSchema,
  wageringRequired: MoneyAmountSchema,
  wageringProgress: MoneyAmountSchema,
  activeGrants: z.number().int().nonnegative(),
});

export type BonusBalance = z.infer<typeof BonusBalanceSchema>;

/**
 * A change *signal*, never the figures themselves, exactly like the wallet balance stream: a
 * dropped or reordered message would leave a stale amount on screen that never corrects itself,
 * and this shape only says what moved so the client refetches `GET /promo/balance`.
 *
 * It covers the changes a client cannot see coming - a deposit's bonus landing from a job, the
 * expiry sweep, an admin forfeiting, a requirement completing. Wagering progress moving on the
 * player's own bet is not on here: the debit the client just made already answers it.
 */
export const BonusBalanceChangeReasonSchema = z.enum([
  'granted',
  'completed',
  'expired',
  'forfeited',
]);

export type BonusBalanceChangeReason = z.infer<typeof BonusBalanceChangeReasonSchema>;

export const BonusBalanceUpdateSchema = z.object({
  eventId: UuidSchema,
  currency: CurrencyTickerSchema,
  reason: BonusBalanceChangeReasonSchema,
});

export type BonusBalanceUpdate = z.infer<typeof BonusBalanceUpdateSchema>;

/** One movement of a player's bonus funds, as they are allowed to see it. */
export const PlayerGrantEntrySchema = z.object({
  id: UuidSchema,
  type: z.enum(BONUS_GRANT_ENTRY_TYPES),
  currency: CurrencyTickerSchema,
  bonusAmount: MoneyAmountSchema,
  realAmount: MoneyAmountSchema,
  wageringDelta: MoneyAmountSchema,
  balanceAfter: MoneyAmountSchema,
  createdAt: TimestampSchema,
});

export type PlayerGrantEntry = z.infer<typeof PlayerGrantEntrySchema>;

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
    grants: {
      list: oc
        .route({ method: 'GET', path: '/backoffice/promo/players/{userId}/grants' })
        .input(z.object({ userId: UuidSchema, ...PageQuerySchema.shape }))
        .output(z.array(AdminGrantSchema)),

      forfeit: oc
        .route({ method: 'POST', path: '/backoffice/promo/grants/{id}/forfeit' })
        .input(ForfeitGrantInputSchema)
        .output(AdminGrantSchema),
    },

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

    weights: {
      list: oc
        .route({ method: 'GET', path: '/backoffice/promo/weight-profiles' })
        .output(z.array(WagerWeightProfileDetailSchema)),

      create: oc
        .route({ method: 'POST', path: '/backoffice/promo/weight-profiles' })
        .input(CreateWagerWeightProfileInputSchema)
        .output(WagerWeightProfileDetailSchema),

      set: oc
        .route({ method: 'PUT', path: '/backoffice/promo/weight-profiles/{id}/weights' })
        .input(SetWagerWeightsInputSchema)
        .output(WagerWeightProfileDetailSchema),
    },
  },

  balance: {
    get: oc
      .route({ method: 'GET', path: '/promo/balance' })
      .input(z.object({ currency: CurrencyTickerSchema.optional() }))
      .output(z.array(BonusBalanceSchema)),

    stream: oc
      .route({ method: 'GET', path: '/promo/balance/stream' })
      .output(eventIterator(BonusBalanceUpdateSchema)),
  },

  grants: {
    list: oc
      .route({ method: 'GET', path: '/promo/grants' })
      .input(ListPlayerGrantsInputSchema)
      .output(paginated(PlayerGrantSchema)),

    get: oc
      .route({ method: 'GET', path: '/promo/grants/{id}' })
      .input(z.object({ id: UuidSchema }))
      .output(PlayerGrantSchema),

    /**
     * The movements behind one of the player's own bonuses. The acceptance criterion is that
     * every credit, debit, conversion and forfeiture is visible in their history, and bonus-only
     * movements never reach the wallet ledger.
     */
    entries: oc
      .route({ method: 'GET', path: '/promo/grants/{id}/entries' })
      .input(z.object({ id: UuidSchema, ...PageQuerySchema.shape }))
      .output(paginated(PlayerGrantEntrySchema)),
  },
};

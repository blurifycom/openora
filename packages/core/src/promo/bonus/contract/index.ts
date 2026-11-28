import { eventIterator, oc } from '@orpc/contract';
import * as z from 'zod';
import {
  BONUS_FORFEIT_REASONS,
  BONUS_GRANT_ENTRY_TYPES,
  BONUS_GRANT_SOURCES,
  BONUS_GRANT_STATUSES,
  BonusBetClassSchema,
  BonusGrantBucketSchema,
  BonusGrantSourceSchema,
  BonusExistingBalanceModeSchema,
  BonusFreeFundsOrderSchema,
  BonusGrantStatusSchema,
  BonusForfeitReasonSchema,
  BonusRolloverBaseSchema,
  ContributionPercentSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  PROMO_OFFER_STATUSES,
  PageQuerySchema,
  paginated,
  PromoOfferStatusSchema,
  ReferenceEdgeSchema,
  SignedMoneyAmountSchema,
  TimestampSchema,
  TurnoverEntryStatusSchema,
  TurnoverSummarySchema,
  UuidSchema,
  WALLET_TRANSFER_CREDIT_KINDS,
  WagerContributionModeSchema,
  WagerProductSchema,
  type BonusGrantSource,
  type WagerProduct,
} from '@openora/core/contracts';

const REAL_MONEY_ONLY_PRODUCTS = ['sportsbook'] as const satisfies readonly WagerProduct[];

export const isRealMoneyOnlyProduct = (product: WagerProduct): boolean =>
  REAL_MONEY_ONLY_PRODUCTS.some((p) => p === product);

const PositiveMoneyAmountSchema = MoneyAmountSchema.refine(
  (amount) => /[1-9]/.test(amount),
  'must be above zero',
);

export const WAGER_WEIGHT_SCOPES = ['game', 'category', 'product', 'default'] as const;
export const WagerWeightScopeSchema = z.enum(WAGER_WEIGHT_SCOPES);
export type WagerWeightScope = z.infer<typeof WagerWeightScopeSchema>;

export const WagerWeightSchema = z.object({
  id: UuidSchema,
  profileId: UuidSchema,
  scope: WagerWeightScopeSchema,
  scopeRef: z.string().min(1).nullable(),
  contributionPercent: ContributionPercentSchema,
  createdAt: TimestampSchema,
});

export type WagerWeight = z.infer<typeof WagerWeightSchema>;

export const WagerWeightProfileSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(120),
  contributionMode: WagerContributionModeSchema,
  referenceEdge: ReferenceEdgeSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type WagerWeightProfile = z.infer<typeof WagerWeightProfileSchema>;

export const WagerWeightProfileDetailSchema = WagerWeightProfileSchema.extend({
  weights: z.array(WagerWeightSchema.omit({ profileId: true })),
});

export type WagerWeightProfileDetail = z.infer<typeof WagerWeightProfileDetailSchema>;

const ContributionInputSchema = z.object({
  contributionMode: WagerContributionModeSchema.optional(),
  referenceEdge: ReferenceEdgeSchema.optional(),
});

const edgeMatchesMode = (v: z.infer<typeof ContributionInputSchema>) =>
  v.contributionMode === undefined
    ? v.referenceEdge === undefined
    : (v.contributionMode === 'house_edge') === (v.referenceEdge !== undefined);
const EDGE_MATCHES_MODE = 'house_edge needs a referenceEdge, and flat or an absent mode takes none';

export const CreateWagerWeightProfileInputSchema = ContributionInputSchema.extend({
  name: z.string().min(1).max(120),
}).refine(edgeMatchesMode, EDGE_MATCHES_MODE);

export type CreateWagerWeightProfileInput = z.infer<typeof CreateWagerWeightProfileInputSchema>;

export const SetWagerWeightsInputSchema = ContributionInputSchema.extend({
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
}).refine(edgeMatchesMode, EDGE_MATCHES_MODE);

export type SetWagerWeightsInput = z.infer<typeof SetWagerWeightsInputSchema>;

export const PromoOfferRulesSchema = z.object({
  firstDepositOnly: z.boolean().default(false),
  freeSpins: z.number().int().positive().optional(),
  periodDays: z.number().int().positive().optional(),
});

export type PromoOfferRules = z.infer<typeof PromoOfferRulesSchema>;

const BucketListSchema = z
  .array(BonusGrantBucketSchema)
  .max(3)
  .refine((buckets) => new Set(buckets).size === buckets.length, 'a bucket is listed twice');

export const BetClassBucketsSchema = z.partialRecord(BonusBetClassSchema, BucketListSchema);

export const BonusFundSettingsSchema = z.object({
  rolloverBase: BonusRolloverBaseSchema.default('bonus'),
  existingBalance: BonusExistingBalanceModeSchema.default('free'),
  freeFundsOrder: BonusFreeFundsOrderSchema.default('first'),
  dustThresholdUsd: MoneyAmountSchema.default('0.01'),
  decimals: z.number().int().min(0).max(18).default(18),
  lockWithdrawals: z.boolean().optional(),
  betClassBuckets: BetClassBucketsSchema.optional(),
});

export const BonusGrantTermsSchema = z.object({
  wageringMultiplier: MoneyAmountSchema,
  expiryDays: z.number().int().positive().max(365),
  weightProfileId: UuidSchema.optional(),
  maxBet: MoneyAmountSchema.nullable().optional(),
  maxBetRate: PositiveMoneyAmountSchema.nullable().optional(),
  maxBetFloor: PositiveMoneyAmountSchema.nullable().optional(),
  maxBetCeiling: PositiveMoneyAmountSchema.nullable().optional(),
  maxBetExemptProducts: z.array(WagerProductSchema).optional(),
  maxWinMultiplier: MoneyAmountSchema.nullable().optional(),
  excludedProducts: z.array(WagerProductSchema).optional(),
  funds: BonusFundSettingsSchema.optional(),
  allowPlayerForfeit: z.boolean().optional(),
});

export const StakeWagerInputsSchema = z.object({
  mode: WagerContributionModeSchema,
  rtp: z.string().nullable(),
  categoryPercent: z.string(),
  referenceEdge: z.string().nullable(),
  effectivePercent: z.string(),
  profileVersion: z.number().int().nullable(),
  betClass: BonusBetClassSchema,
});

export type StakeWagerInputs = z.infer<typeof StakeWagerInputsSchema>;

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
  requiresOptIn: z.boolean().default(true),
  validFrom: TimestampSchema.nullable().default(null),
  validUntil: TimestampSchema.nullable().default(null),
});

export type CreatePromoOfferInput = z.infer<typeof CreatePromoOfferInputSchema>;

export const UpdatePromoOfferInputSchema = PromoOfferSchema.omit({
  id: true,
  key: true,
  createdAt: true,
  updatedAt: true,
})
  .partial()
  .extend({ id: UuidSchema });

export type UpdatePromoOfferInput = z.infer<typeof UpdatePromoOfferInputSchema>;

export const PublicOfferSchema = PromoOfferSchema.pick({
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
});

export type PublicOffer = z.infer<typeof PublicOfferSchema>;

export const PlayerOfferSchema = PublicOfferSchema.extend({
  optedIn: z.boolean(),
  claimed: z.boolean(),
  accumulatedDeposit: MoneyAmountSchema,
});

export type PlayerOffer = z.infer<typeof PlayerOfferSchema>;

export const PlayerGrantSchema = z.object({
  id: UuidSchema,
  offerId: UuidSchema.nullable(),
  offerKey: z.string().nullable(),
  offerName: z.string().nullable(),
  currency: CurrencyTickerSchema,
  source: BonusGrantSourceSchema,
  sourceRef: z.string(),
  status: BonusGrantStatusSchema,
  grantedAmount: MoneyAmountSchema,
  bonusBalance: MoneyAmountSchema,
  wageringRequired: MoneyAmountSchema,
  wageringProgress: MoneyAmountSchema,
  pendingWagered: MoneyAmountSchema.optional(),
  linkedCash: MoneyAmountSchema,
  unlinkedCash: MoneyAmountSchema,
  forfeitReason: BonusForfeitReasonSchema.nullable(),
  maxBet: MoneyAmountSchema.nullable(),
  playerForfeitable: z.boolean(),
  expiresAt: TimestampSchema,
  activatedAt: TimestampSchema.nullable(),
  closedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

export type PlayerGrant = z.infer<typeof PlayerGrantSchema>;

export const AdminGrantSchema = PlayerGrantSchema.extend({
  userId: UuidSchema,
  forfeitedBy: z
    .object({ id: UuidSchema, name: z.string().nullable(), email: z.string().nullable() })
    .nullable(),
  forfeitNote: z.string().nullable(),
  closedAmount: MoneyAmountSchema.nullable(),
});

export type AdminGrant = z.infer<typeof AdminGrantSchema>;

export const AdminPlayerFundsSchema = z.object({
  activeCurrency: CurrencyTickerSchema,
  balances: z.array(
    z.object({
      currency: CurrencyTickerSchema,
      balance: MoneyAmountSchema,
      locked: MoneyAmountSchema,
      free: MoneyAmountSchema,
      bonusLocked: MoneyAmountSchema.optional(),
    }),
  ),
  turnover: TurnoverSummarySchema.optional(),
});

export type AdminPlayerFunds = z.infer<typeof AdminPlayerFundsSchema>;

export const ForfeitGrantInputSchema = z.object({
  id: UuidSchema,
  note: z.string().trim().min(10).max(500),
});

export const TRANSFER_GRANT_SOURCES =
  WALLET_TRANSFER_CREDIT_KINDS satisfies readonly BonusGrantSource[];
export const TransferGrantSourceSchema = z.enum(TRANSFER_GRANT_SOURCES);
export type TransferGrantSource = z.infer<typeof TransferGrantSourceSchema>;

export const ConvertTransferGrantsInputSchema = z.object({
  sources: z.array(TransferGrantSourceSchema).min(1),
  limit: z.number().int().min(1).max(500).default(100),
  dryRun: z.boolean().optional(),
  after: UuidSchema.optional(),
});
export type ConvertTransferGrantsInput = z.infer<typeof ConvertTransferGrantsInputSchema>;

export const ConvertedTransferGrantSchema = z.object({
  grantId: UuidSchema,
  userId: UuidSchema,
  currency: CurrencyTickerSchema,
  cash: MoneyAmountSchema,
  requiredInCurrency: MoneyAmountSchema,
  entryStatus: TurnoverEntryStatusSchema.nullable(),
});
export type ConvertedTransferGrant = z.infer<typeof ConvertedTransferGrantSchema>;

export const TRANSFER_GRANT_CONVERSION_FAILURES = [
  'credit_refused',
  'replay_mismatch',
  'invalid_amount',
  'failed',
] as const;
export const TransferGrantConversionFailureSchema = z.enum(TRANSFER_GRANT_CONVERSION_FAILURES);
export type TransferGrantConversionFailure = z.infer<typeof TransferGrantConversionFailureSchema>;

export const ConvertTransferGrantsResultSchema = z.object({
  converted: z.array(ConvertedTransferGrantSchema),
  failed: z
    .array(z.object({ grantId: UuidSchema, reason: TransferGrantConversionFailureSchema }))
    .optional(),
  skippedOpenRound: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  nextCursor: UuidSchema.nullable(),
});
export type ConvertTransferGrantsResult = z.infer<typeof ConvertTransferGrantsResultSchema>;

export const BonusBalanceSchema = z.object({
  currency: CurrencyTickerSchema,
  bonus: MoneyAmountSchema,
  wageringRequired: MoneyAmountSchema,
  wageringProgress: MoneyAmountSchema,
  activeGrants: z.number().int().nonnegative(),
  maxBet: MoneyAmountSchema.nullable(),
});

export type BonusBalance = z.infer<typeof BonusBalanceSchema>;

export const BonusBalanceChangeReasonSchema = z.enum([
  'granted',
  'activated',
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

export const PlayerGrantEntrySchema = z.object({
  id: UuidSchema,
  type: z.enum(BONUS_GRANT_ENTRY_TYPES),
  currency: CurrencyTickerSchema,
  bonusAmount: SignedMoneyAmountSchema,
  realAmount: MoneyAmountSchema,
  wageringDelta: SignedMoneyAmountSchema,
  balanceAfter: MoneyAmountSchema,
  createdAt: TimestampSchema,
});

export type PlayerGrantEntry = z.infer<typeof PlayerGrantEntrySchema>;

export const ListPlayerGrantsInputSchema = z.object({
  ...PageQuerySchema.shape,
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

    listPublic: oc
      .route({ method: 'GET', path: '/promo/offers/public' })
      .output(z.array(PublicOfferSchema)),

    optIn: oc
      .route({ method: 'POST', path: '/promo/offers/{id}/opt-in' })
      .input(z.object({ id: UuidSchema }))
      .output(PlayerOfferSchema),
  },

  admin: {
    players: {
      funds: oc
        .route({ method: 'GET', path: '/backoffice/promo/players/{userId}/funds' })
        .input(z.object({ userId: UuidSchema }))
        .output(AdminPlayerFundsSchema),
    },

    grants: {
      list: oc
        .route({ method: 'GET', path: '/backoffice/promo/players/{userId}/grants' })
        .input(z.object({ userId: UuidSchema, ...PageQuerySchema.shape }))
        .output(z.array(AdminGrantSchema)),

      forfeit: oc
        .route({ method: 'POST', path: '/backoffice/promo/grants/{id}/forfeit' })
        .input(ForfeitGrantInputSchema)
        .output(AdminGrantSchema),

      convertTransferGrants: oc
        .route({ method: 'POST', path: '/backoffice/promo/grants/convert-transfer-grants' })
        .input(ConvertTransferGrantsInputSchema)
        .output(ConvertTransferGrantsResultSchema),
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

    activate: oc
      .route({ method: 'POST', path: '/promo/grants/{id}/activate' })
      .input(z.object({ id: UuidSchema }))
      .output(PlayerGrantSchema),

    entries: oc
      .route({ method: 'GET', path: '/promo/grants/{id}/entries' })
      .input(z.object({ id: UuidSchema, ...PageQuerySchema.shape }))
      .output(paginated(PlayerGrantEntrySchema)),

    forfeit: oc
      .route({ method: 'POST', path: '/promo/grants/{id}/forfeit' })
      .input(z.object({ id: UuidSchema }))
      .output(PlayerGrantSchema),
  },
};
export * from './agent-tools.js';

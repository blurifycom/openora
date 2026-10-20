import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CountryCodeSchema,
  CurrencyTickerInputSchema,
  CurrencyTickerSchema,
  DateRangeSchema,
  IdInputSchema,
  LanguageTagSchema,
  MONEY_SCALE,
  MoneyAmountSchema,
  NonEmptyReasonSchema,
  PageQuerySchema,
  SportsbookBetLegSchema,
  SportsbookBetResultSchema,
  SportsbookBetStatusSchema,
  SportsbookCancelReasonSchema,
  SportsbookProviderBetStatusSchema,
  SportsbookProviderNameSchema,
  SportsbookProviderIdSchema,
  SportsbookPromotionTypeSchema,
  SignedMoneyAmountSchema,
  TimestampSchema,
  UserIdInputSchema,
  UuidSchema,
  paginated,
  queue,
} from '@openora/core/contracts';

export {
  SportsbookBetLegSchema,
  SportsbookBetResultSchema,
  SportsbookBetStatusSchema,
  SportsbookCancelReasonSchema,
} from '@openora/core/contracts';

export const SPORTSBOOK_TRANSACTION_KINDS = [
  'reserve',
  'confirm',
  'cancel',
  'settle',
  'reopen',
] as const;
export const SportsbookTransactionKindSchema = z.enum(SPORTSBOOK_TRANSACTION_KINDS);
export type SportsbookTransactionKind = z.infer<typeof SportsbookTransactionKindSchema>;

export const SPORTSBOOK_DEBT_STATUSES = ['open', 'cleared', 'written_off'] as const;
export const SportsbookDebtStatusSchema = z.enum(SPORTSBOOK_DEBT_STATUSES);
export type SportsbookDebtStatus = z.infer<typeof SportsbookDebtStatusSchema>;

export const SPORTSBOOK_DEBT_ACTIONS = ['collected', 'written_off'] as const;
export const SportsbookDebtActionSchema = z.enum(SPORTSBOOK_DEBT_ACTIONS);
export type SportsbookDebtAction = z.infer<typeof SportsbookDebtActionSchema>;

export const SPORTSBOOK_FINDING_KINDS = [
  'fingerprint_mismatch',
  'payout_above_potential',
  'invalid_amount',
  'debt_recorded',
  'reserve_unresolved',
  'settlement_overdue',
  'provider_mismatch',
  'promotion_payout_unusual',
] as const;
export const SportsbookFindingKindSchema = z.enum(SPORTSBOOK_FINDING_KINDS);
export type SportsbookFindingKind = z.infer<typeof SportsbookFindingKindSchema>;

export const SPORTSBOOK_FINDING_STATUSES = ['open', 'resolved'] as const;
export const SportsbookFindingStatusSchema = z.enum(SPORTSBOOK_FINDING_STATUSES);
export type SportsbookFindingStatus = z.infer<typeof SportsbookFindingStatusSchema>;

/** The provider key the wallet ledger rows of this module carry, so they never collide with a casino provider's references. */
export const SPORTSBOOK_WALLET_PROVIDER_PREFIX = 'sportsbook:';
/** `source` of the withdrawal hold sportsbook debt places. */
export const SPORTSBOOK_HOLD_SOURCE = 'sportsbook';

export const SportsbookCurrencySchema = z.object({
  currency: CurrencyTickerInputSchema,
  /** Decimal places the provider settles this currency in; a payout with more is refused. */
  decimals: z.int().min(0).max(MONEY_SCALE),
});
export type SportsbookCurrency = z.infer<typeof SportsbookCurrencySchema>;

export const SPORTSBOOK_CONFIG_DEFAULTS = {
  reserveTimeoutSeconds: 300,
  settlementGraceMinutes: 1440,
  sessionTtlMinutes: 240,
} as const;

export const SPORTSBOOK_PROMOTION_FUNDERS = ['operator', 'provider'] as const;
export const SportsbookPromotionFunderSchema = z.enum(SPORTSBOOK_PROMOTION_FUNDERS);
export type SportsbookPromotionFunder = z.infer<typeof SportsbookPromotionFunderSchema>;

const atMost = (max: number) => (record: Record<string, unknown>) =>
  Object.keys(record).length <= max;

export const SportsbookPromotionsConfigSchema = z.object({
  /** Off by default: a reserve that carries a promotion is refused until the operator opts in. */
  enabled: z.boolean(),
  /** The largest promotion-paid stake, valued in USD at reserve; `null` caps none. */
  maxPromotionStakeUsd: MoneyAmountSchema.nullable(),
  /** Who funds each promotion type, for the report only; a type left out is the operator's. */
  funder: z
    .record(SportsbookPromotionTypeSchema, SportsbookPromotionFunderSchema)
    .refine(atMost(200), 'at most 200 promotion types'),
});
export type SportsbookPromotionsConfig = z.infer<typeof SportsbookPromotionsConfigSchema>;

export const SPORTSBOOK_PROMOTIONS_DEFAULTS = {
  enabled: false,
  maxPromotionStakeUsd: null,
  funder: {},
} as const satisfies SportsbookPromotionsConfig;

const configFields = {
  enabled: z.boolean(),
  currencies: z
    .array(SportsbookCurrencySchema)
    .max(50)
    .refine((list) => new Set(list.map((c) => c.currency)).size === list.length, {
      message: 'each currency at most once',
    }),
  /** Countries the sportsbook refuses on top of the platform's own geo blocks. */
  blockedCountries: z.array(CountryCodeSchema).max(250),
  reserveTimeoutSeconds: z.int().min(30).max(86_400),
  settlementGraceMinutes: z.int().min(10).max(43_200),
  sessionTtlMinutes: z.int().min(5).max(1_440),
};

export const SportsbookConfigSchema = z.object({
  ...configFields,
  currencies: z.array(SportsbookCurrencySchema.extend({ currency: CurrencyTickerSchema })),
  promotions: SportsbookPromotionsConfigSchema,
  suspended: z.boolean(),
  updatedAt: TimestampSchema.nullable(),
});
export type SportsbookConfig = z.infer<typeof SportsbookConfigSchema>;

export const UpdateSportsbookConfigInputSchema = z.object({
  ...configFields,
  /** Replaces the stored promotion settings whole; omitted leaves them as they are. */
  promotions: SportsbookPromotionsConfigSchema.optional(),
});
export type UpdateSportsbookConfigInput = z.infer<typeof UpdateSportsbookConfigInputSchema>;

export const SportsbookBetSchema = z.object({
  id: UuidSchema,
  provider: SportsbookProviderNameSchema,
  providerBetId: SportsbookProviderIdSchema,
  currency: CurrencyTickerSchema,
  status: SportsbookBetStatusSchema,
  result: SportsbookBetResultSchema.nullable(),
  stake: MoneyAmountSchema,
  potentialPayout: MoneyAmountSchema,
  payoutTotal: MoneyAmountSchema,
  version: z.int(),
  legs: z.array(SportsbookBetLegSchema),
  lastLegStartsAt: TimestampSchema,
  createdAt: TimestampSchema,
  acceptedAt: TimestampSchema.nullable(),
  settledAt: TimestampSchema.nullable(),
  cancelledAt: TimestampSchema.nullable(),
});
export type SportsbookBet = z.infer<typeof SportsbookBetSchema>;

export const AdminSportsbookBetSchema = SportsbookBetSchema.extend({
  userId: UuidSchema,
  sessionId: UuidSchema,
  /** What the player paid of `stake`: zero for a promotion-paid stake. */
  cashStake: MoneyAmountSchema,
  voidPayout: MoneyAmountSchema,
  maxLossRefund: MoneyAmountSchema,
  promotionType: SportsbookPromotionTypeSchema.nullable(),
  promotionId: SportsbookProviderIdSchema.nullable(),
  /** Who funds the promotion, as the funder map named it when the bet was reserved. */
  promotionFunder: SportsbookPromotionFunderSchema.nullable(),
  promotionPotential: MoneyAmountSchema.nullable(),
  /** The part of `payoutTotal` a promotion funded. */
  promotionPaid: MoneyAmountSchema,
});
export type AdminSportsbookBet = z.infer<typeof AdminSportsbookBetSchema>;

export const SportsbookBetTransactionSchema = z.object({
  id: UuidSchema,
  providerTxId: SportsbookProviderIdSchema,
  kind: SportsbookTransactionKindSchema,
  amount: MoneyAmountSchema,
  potentialPayout: MoneyAmountSchema.nullable(),
  legs: z.array(SportsbookBetLegSchema).nullable(),
  promotionPotential: MoneyAmountSchema.nullable(),
  betVersion: z.int(),
  result: SportsbookBetResultSchema.nullable(),
  cancelReason: SportsbookCancelReasonSchema.nullable(),
  walletTransactionIds: z.array(UuidSchema),
  balanceAfter: MoneyAmountSchema.nullable(),
  promotionAmount: MoneyAmountSchema.nullable(),
  createdAt: TimestampSchema,
});
export type SportsbookBetTransaction = z.infer<typeof SportsbookBetTransactionSchema>;

export const AdminSportsbookBetDetailSchema = AdminSportsbookBetSchema.extend({
  transactions: z.array(SportsbookBetTransactionSchema),
  /** Whether the bound provider can report this bet's status, which align needs. */
  providerStatusLookup: z.boolean(),
});
export type AdminSportsbookBetDetail = z.infer<typeof AdminSportsbookBetDetailSchema>;

export const ListSportsbookBetsInputSchema = PageQuerySchema.extend({
  status: SportsbookBetStatusSchema.optional(),
});
export type ListSportsbookBetsInput = z.infer<typeof ListSportsbookBetsInputSchema>;

// A provider bet id is unique per provider only, and the index leads with the provider.
export const ListAdminSportsbookBetsInputSchema = ListSportsbookBetsInputSchema.extend({
  userId: UuidSchema.optional(),
  provider: SportsbookProviderNameSchema.optional(),
  providerBetId: SportsbookProviderIdSchema.optional(),
}).refine((input) => !input.providerBetId || input.provider, {
  message: 'providerBetId needs provider',
  path: ['provider'],
});
export type ListAdminSportsbookBetsInput = z.infer<typeof ListAdminSportsbookBetsInputSchema>;

export const IssueSportsbookSessionInputSchema = z.object({
  currency: CurrencyTickerInputSchema,
  locale: LanguageTagSchema.optional(),
});
export type IssueSportsbookSessionInput = z.infer<typeof IssueSportsbookSessionInputSchema>;

export const SportsbookSessionSchema = z.object({
  sessionId: UuidSchema,
  token: z.string(),
  launchUrl: z.url({ protocol: /^https$/ }).nullable(),
  currency: CurrencyTickerSchema,
  expiresAt: TimestampSchema,
});
export type SportsbookSession = z.infer<typeof SportsbookSessionSchema>;

const ReasonSchema = NonEmptyReasonSchema.max(500);

export const SetSportsbookRestrictionInputSchema = UserIdInputSchema.extend({
  reason: ReasonSchema,
});
export type SetSportsbookRestrictionInput = z.infer<typeof SetSportsbookRestrictionInputSchema>;

export const ReasonInputSchema = z.object({ reason: ReasonSchema });
export type ReasonInput = z.infer<typeof ReasonInputSchema>;

export const SportsbookRestrictionSchema = z.object({
  userId: UuidSchema,
  restricted: z.boolean(),
  reason: z.string().nullable(),
  createdAt: TimestampSchema.nullable(),
});
export type SportsbookRestriction = z.infer<typeof SportsbookRestrictionSchema>;

export const SportsbookFindingSchema = z.object({
  id: UuidSchema,
  kind: SportsbookFindingKindSchema,
  provider: SportsbookProviderNameSchema.nullable(),
  betId: UuidSchema.nullable(),
  userId: UuidSchema.nullable(),
  /**
   * The bet's currency, which any amount in `detail` is in; null when there is no bet, where a
   * refused stake's `detail` names its own.
   */
  currency: CurrencyTickerSchema.nullable(),
  detail: z.record(z.string(), z.unknown()),
  status: SportsbookFindingStatusSchema,
  resolvedBy: UuidSchema.nullable(),
  resolvedAt: TimestampSchema.nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type SportsbookFinding = z.infer<typeof SportsbookFindingSchema>;

export const ListSportsbookFindingsInputSchema = PageQuerySchema.extend({
  status: SportsbookFindingStatusSchema.optional(),
  kind: SportsbookFindingKindSchema.optional(),
  userId: UuidSchema.optional(),
});
export type ListSportsbookFindingsInput = z.infer<typeof ListSportsbookFindingsInputSchema>;

export const ResolveSportsbookFindingInputSchema = IdInputSchema.extend({
  note: NonEmptyReasonSchema.max(1000),
});
export type ResolveSportsbookFindingInput = z.infer<typeof ResolveSportsbookFindingInputSchema>;

export const SportsbookDebtSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  currency: CurrencyTickerSchema,
  owed: MoneyAmountSchema,
  collected: MoneyAmountSchema,
  writtenOff: MoneyAmountSchema,
  outstanding: MoneyAmountSchema,
  status: SportsbookDebtStatusSchema,
  /** Whether the player's sportsbook withdrawal hold is in place right now. */
  holdActive: z.boolean(),
  writtenOffBy: UuidSchema.nullable(),
  writtenOffReason: z.string().nullable(),
  writtenOffAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type SportsbookDebt = z.infer<typeof SportsbookDebtSchema>;

export const ListSportsbookDebtsInputSchema = PageQuerySchema.extend({
  status: SportsbookDebtStatusSchema.optional(),
  userId: UuidSchema.optional(),
});
export type ListSportsbookDebtsInput = z.infer<typeof ListSportsbookDebtsInputSchema>;

export const CollectSportsbookDebtInputSchema = IdInputSchema.extend({
  idempotencyKey: UuidSchema,
});
export type CollectSportsbookDebtInput = z.infer<typeof CollectSportsbookDebtInputSchema>;

export const WriteOffSportsbookDebtInputSchema = IdInputSchema.extend({
  reason: ReasonSchema,
  idempotencyKey: UuidSchema,
});
export type WriteOffSportsbookDebtInput = z.infer<typeof WriteOffSportsbookDebtInputSchema>;

export const AlignSportsbookBetOutputSchema = z.object({
  bet: AdminSportsbookBetSchema,
  providerStatus: SportsbookProviderBetStatusSchema,
  applied: z.array(SportsbookTransactionKindSchema),
});
export type AlignSportsbookBetOutput = z.infer<typeof AlignSportsbookBetOutputSchema>;

export const SportsbookPromotionReportInputSchema = DateRangeSchema;
export type SportsbookPromotionReportInput = z.infer<typeof SportsbookPromotionReportInputSchema>;

export const SportsbookPromotionReportRowSchema = z.object({
  type: SportsbookPromotionTypeSchema,
  funder: SportsbookPromotionFunderSchema,
  currency: CurrencyTickerSchema,
  /** Settles in the range that paid a promotion part. */
  bets: z.int().nonnegative(),
  promotionPaid: MoneyAmountSchema,
  /**
   * The promotion part of settlements reopened in the range, whether or not the player's balance
   * covered it; what a reopen could not collect is sportsbook debt.
   */
  promotionReversed: MoneyAmountSchema,
});
export type SportsbookPromotionReportRow = z.infer<typeof SportsbookPromotionReportRowSchema>;

export const SportsbookPlayerSummaryInputSchema = DateRangeSchema.extend(UserIdInputSchema.shape);
export type SportsbookPlayerSummaryInput = z.infer<typeof SportsbookPlayerSummaryInputSchema>;

/**
 * One currency of a player's accepted and settled bets, as each bet stands now. Stake-side fields
 * count bets accepted in the range, payout-side fields bets settled in it, and `openExposure` is
 * now, whatever the range.
 */
export const SportsbookPlayerSummaryRowSchema = z.object({
  currency: CurrencyTickerSchema,
  bets: z.int().nonnegative(),
  stake: MoneyAmountSchema,
  cashStake: MoneyAmountSchema,
  promotionStake: MoneyAmountSchema,
  /** Everything settlement paid back, a void's returned stake included. */
  payout: MoneyAmountSchema,
  cashPayout: MoneyAmountSchema,
  promotionPayout: MoneyAmountSchema,
  /**
   * `cashStake - payout`: a promotion-paid stake earns nothing and a promotion payout costs in
   * full, as on the wallet ledger. Bet-level, so a reopened bet's uncollected reversal is not in it.
   */
  ggr: SignedMoneyAmountSchema,
  openExposure: MoneyAmountSchema,
});
export type SportsbookPlayerSummaryRow = z.infer<typeof SportsbookPlayerSummaryRowSchema>;

export const sportsbookContract = {
  issueSession: oc
    .route({ method: 'POST', path: '/sportsbook/session' })
    .input(IssueSportsbookSessionInputSchema)
    .output(SportsbookSessionSchema),
  listBets: oc
    .route({ method: 'GET', path: '/sportsbook/bets' })
    .input(ListSportsbookBetsInputSchema)
    .output(paginated(SportsbookBetSchema)),
  getBet: oc
    .route({ method: 'GET', path: '/sportsbook/bets/{id}' })
    .input(IdInputSchema)
    .output(SportsbookBetSchema),
};

export const sportsbookAdminContract = {
  adminListBets: oc
    .route({ method: 'GET', path: '/backoffice/sportsbook/bets' })
    .input(ListAdminSportsbookBetsInputSchema)
    .output(paginated(AdminSportsbookBetSchema)),
  adminGetBet: oc
    .route({ method: 'GET', path: '/backoffice/sportsbook/bets/{id}' })
    .input(IdInputSchema)
    .output(AdminSportsbookBetDetailSchema),
  alignBet: oc
    .route({ method: 'POST', path: '/backoffice/sportsbook/bets/{id}/align' })
    .input(IdInputSchema)
    .output(AlignSportsbookBetOutputSchema),
  getConfig: oc
    .route({ method: 'GET', path: '/backoffice/sportsbook/config' })
    .output(SportsbookConfigSchema),
  updateConfig: oc
    .route({ method: 'PUT', path: '/backoffice/sportsbook/config' })
    .input(UpdateSportsbookConfigInputSchema)
    .output(SportsbookConfigSchema),
  suspend: oc
    .route({ method: 'POST', path: '/backoffice/sportsbook/suspend' })
    .input(ReasonInputSchema)
    .output(SportsbookConfigSchema),
  resume: oc
    .route({ method: 'POST', path: '/backoffice/sportsbook/resume' })
    .input(ReasonInputSchema)
    .output(SportsbookConfigSchema),
  getRestriction: oc
    .route({ method: 'GET', path: '/backoffice/sportsbook/players/{userId}/restriction' })
    .input(UserIdInputSchema)
    .output(SportsbookRestrictionSchema),
  playerSummary: oc
    .route({ method: 'GET', path: '/backoffice/sportsbook/players/{userId}/summary' })
    .input(SportsbookPlayerSummaryInputSchema)
    .output(z.array(SportsbookPlayerSummaryRowSchema)),
  restrictPlayer: oc
    .route({ method: 'POST', path: '/backoffice/sportsbook/players/{userId}/restriction' })
    .input(SetSportsbookRestrictionInputSchema)
    .output(SportsbookRestrictionSchema),
  liftRestriction: oc
    .route({ method: 'DELETE', path: '/backoffice/sportsbook/players/{userId}/restriction' })
    .input(SetSportsbookRestrictionInputSchema)
    .output(SportsbookRestrictionSchema),
  listFindings: oc
    .route({ method: 'GET', path: '/backoffice/sportsbook/findings' })
    .input(ListSportsbookFindingsInputSchema)
    .output(paginated(SportsbookFindingSchema)),
  resolveFinding: oc
    .route({ method: 'POST', path: '/backoffice/sportsbook/findings/{id}/resolve' })
    .input(ResolveSportsbookFindingInputSchema)
    .output(SportsbookFindingSchema),
  listDebts: oc
    .route({ method: 'GET', path: '/backoffice/sportsbook/debts' })
    .input(ListSportsbookDebtsInputSchema)
    .output(paginated(SportsbookDebtSchema)),
  collectDebt: oc
    .route({ method: 'POST', path: '/backoffice/sportsbook/debts/{id}/collect' })
    .input(CollectSportsbookDebtInputSchema)
    .output(SportsbookDebtSchema),
  writeOffDebt: oc
    .route({ method: 'POST', path: '/backoffice/sportsbook/debts/{id}/write-off' })
    .input(WriteOffSportsbookDebtInputSchema)
    .output(SportsbookDebtSchema),
  promotionReport: oc
    .route({ method: 'GET', path: '/backoffice/sportsbook/promotions/report' })
    .input(SportsbookPromotionReportInputSchema)
    .output(z.array(SportsbookPromotionReportRowSchema)),
};

export const SPORTSBOOK_RECONCILE_QUEUE = queue('sportsbook.reconcile');
export const SportsbookReconcileJobSchema = z.object({});
export const SPORTSBOOK_RECONCILE_CRON = '*/5 * * * *';
export const SPORTSBOOK_RG_REVOKE_QUEUE = queue('sportsbook.rg-revoke');
export const SPORTSBOOK_RG_REVOKE_TRIGGERS = [
  'rg.cooling_off.activated',
  'rg.self_exclusion.activated',
] as const;
export const SportsbookRgRevokeJobSchema = z.object({
  userId: UuidSchema,
  trigger: z.enum(SPORTSBOOK_RG_REVOKE_TRIGGERS),
});
export type SportsbookRgRevokeJob = z.infer<typeof SportsbookRgRevokeJobSchema>;
/** Bets one reconciliation pass looks at per kind; the next pass picks up the rest. */
export const SPORTSBOOK_RECONCILE_BATCH = 200;
/** Status lookups a reserve gets before reconciliation files it as unresolved. */
export const SPORTSBOOK_RECONCILE_MAX_ATTEMPTS = 3;

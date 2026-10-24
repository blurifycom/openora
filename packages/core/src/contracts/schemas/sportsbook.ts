import * as z from 'zod';
import { CurrencyTickerInputSchema, MoneyAmountSchema, UuidSchema } from './common.js';

export const SPORTSBOOK_BET_STATUSES = ['reserved', 'accepted', 'cancelled', 'settled'] as const;
export const SportsbookBetStatusSchema = z.enum(SPORTSBOOK_BET_STATUSES);
export type SportsbookBetStatus = z.infer<typeof SportsbookBetStatusSchema>;

/** A label on a settled bet, not a state: what the provider settled it as. */
export const SPORTSBOOK_BET_RESULTS = [
  'won',
  'lost',
  'void',
  'half_won',
  'half_lost',
  'cashed_out',
] as const;
export const SportsbookBetResultSchema = z.enum(SPORTSBOOK_BET_RESULTS);
export type SportsbookBetResult = z.infer<typeof SportsbookBetResultSchema>;

export const SPORTSBOOK_CANCEL_REASONS = ['rejected', 'discarded'] as const;
export const SportsbookCancelReasonSchema = z.enum(SPORTSBOOK_CANCEL_REASONS);
export type SportsbookCancelReason = z.infer<typeof SportsbookCancelReasonSchema>;

export const SPORTSBOOK_DEBT_CAUSES = ['recorded', 'offset', 'collected', 'written_off'] as const;
export const SportsbookDebtCauseSchema = z.enum(SPORTSBOOK_DEBT_CAUSES);
export type SportsbookDebtCause = z.infer<typeof SportsbookDebtCauseSchema>;

export const SPORTSBOOK_REFUSAL_REASONS = [
  'insufficient_funds',
  'player_blocked',
  'limit',
  'suspended',
  'session_invalid',
  'illegal_transition',
  'fingerprint_mismatch',
  'invalid_amount',
  'bet_not_found',
  'promotion_not_allowed',
  'self_excluded',
  'cooling_off',
  'account_suspended',
  'account_closed',
  'account_inactive',
  'sportsbook_restricted',
  'currency_not_offered',
] as const;
export const SportsbookRefusalReasonSchema = z.enum(SPORTSBOOK_REFUSAL_REASONS);
export type SportsbookRefusalReason = z.infer<typeof SportsbookRefusalReasonSchema>;

/** The provider's own name for itself, e.g. its overlay plugin id. Prefixes every wallet reference. */
export const SportsbookProviderNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'lowercase provider key, e.g. acme-sports');

/** An id the provider minted: a bet id or a transaction id. */
export const SportsbookProviderIdSchema = z.string().trim().min(1).max(128);

export const SportsbookBetLegSchema = z.object({
  eventId: z.string().trim().min(1).max(128),
  eventName: z.string().max(256).optional(),
  market: z.string().max(256).optional(),
  selection: z.string().max(256).optional(),
  odds: z.string().max(32).optional(),
  startsAt: z.iso.datetime({ offset: true }),
});
export type SportsbookBetLeg = z.infer<typeof SportsbookBetLegSchema>;

const ledgerRequest = {
  provider: SportsbookProviderNameSchema,
  providerTxId: SportsbookProviderIdSchema,
  providerBetId: SportsbookProviderIdSchema,
};

const SportsbookBetLegsSchema = z.array(SportsbookBetLegSchema).min(1).max(100);

/** The operator's own name for a promotion; core reports by it and never interprets it. */
export const SportsbookPromotionTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // A record drops this key, so the funder map could never name it; refused, it reaches no bet.
  .refine((type) => type !== '__proto__', 'reserved name');

const promotionLabel = {
  type: SportsbookPromotionTypeSchema,
  /** The provider's id for the promotion granted to the player, when it has one. */
  id: SportsbookProviderIdSchema.optional(),
  /** The promotion's part of `potentialPayout`, for a boost. */
  potentialAmount: MoneyAmountSchema.optional(),
};

/**
 * The money facts of a provider promotion on a bet. Strict, so a fact core does not understand
 * is refused rather than dropped.
 */
export const SportsbookPromotionSchema = z.discriminatedUnion('stake', [
  z
    .object({ ...promotionLabel, stake: z.literal('promotion'), voidReturnsStake: z.boolean() })
    .strict(),
  z.object({ ...promotionLabel, stake: z.literal('player'), refundsLoss: z.boolean() }).strict(),
]);
export type SportsbookPromotion = z.infer<typeof SportsbookPromotionSchema>;

export const SportsbookReserveArgsSchema = z.object({
  ...ledgerRequest,
  sessionId: UuidSchema,
  currency: CurrencyTickerInputSchema,
  stake: MoneyAmountSchema,
  potentialPayout: MoneyAmountSchema,
  legs: SportsbookBetLegsSchema,
  promotion: SportsbookPromotionSchema.optional(),
});
export type SportsbookReserveArgs = z.input<typeof SportsbookReserveArgsSchema>;

export const SportsbookSessionArgsSchema = z.object({
  provider: SportsbookProviderNameSchema,
  sessionId: z.string(),
});
export type SportsbookSessionArgs = z.input<typeof SportsbookSessionArgsSchema>;

/**
 * The terms the provider accepted, sent together or not at all: the reserved legs in the same order,
 * where only the odds may change, and the potential payout they give. The stake never changes.
 * `promotionPotential` is the promotion's part of that payout, for a boost the new odds changed.
 */
export const SportsbookConfirmArgsSchema = z.object({
  ...ledgerRequest,
  potentialPayout: MoneyAmountSchema.optional(),
  legs: SportsbookBetLegsSchema.optional(),
  promotionPotential: MoneyAmountSchema.optional(),
});
export type SportsbookConfirmArgs = z.input<typeof SportsbookConfirmArgsSchema>;

export const SportsbookCancelArgsSchema = z.object({
  ...ledgerRequest,
  reason: SportsbookCancelReasonSchema,
});
export type SportsbookCancelArgs = z.input<typeof SportsbookCancelArgsSchema>;

/** `expectedVersion` pins the settle to the bet version the caller observed; omit it to settle whatever version is open. */
export const SportsbookSettleArgsSchema = z.object({
  ...ledgerRequest,
  result: SportsbookBetResultSchema,
  /** The total payout of this settlement, stake included; `'0'` for a loss. Never a delta. */
  payout: MoneyAmountSchema,
  /** The part of `payout` a promotion funds; core derives it from the bet when omitted. */
  promotionAmount: MoneyAmountSchema.optional(),
  expectedVersion: z.int().positive().optional(),
});
export type SportsbookSettleArgs = z.input<typeof SportsbookSettleArgsSchema>;

export const SportsbookReopenArgsSchema = z.object({
  ...ledgerRequest,
  expectedVersion: z.int().positive().optional(),
});
export type SportsbookReopenArgs = z.input<typeof SportsbookReopenArgsSchema>;

/** What the provider reports for a bet when core asks: reconciliation and align-with-provider act on it. */
export const SportsbookProviderBetStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['pending', 'accepted', 'rejected', 'not_found']) }),
  z.object({
    status: z.literal('settled'),
    result: SportsbookBetResultSchema,
    payout: MoneyAmountSchema,
    promotionAmount: MoneyAmountSchema.optional(),
  }),
]);
export type SportsbookProviderBetStatus = z.infer<typeof SportsbookProviderBetStatusSchema>;

import * as z from 'zod';
import { isWagerRtp, WagerProductSchema } from '../adapters/wager-context.js';
import {
  CurrencyTickerInputSchema,
  CurrencyTickerSchema,
  MONEY_PRECISION,
  MONEY_SCALE,
  MoneyAmountSchema,
  TimestampSchema,
  UuidSchema,
} from './common.js';
import { PlayerStatusSchema } from './player.js';
import {
  SportsbookCancelArgsSchema,
  SportsbookConfirmArgsSchema,
  SportsbookReopenArgsSchema,
  SportsbookReserveArgsSchema,
  SportsbookSettleArgsSchema,
} from './sportsbook.js';

export const LEDGER_RESERVED_PROVIDER_NAME = 'internal';

export const LedgerProviderNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'lowercase provider key, e.g. acme-games')
  .refine((name) => name !== LEDGER_RESERVED_PROVIDER_NAME, 'reserved provider name');

export const LedgerProviderRefSchema = z.string().trim().min(1).max(128);

const LedgerAmountSchema = MoneyAmountSchema.regex(
  new RegExp(`^\\d{1,${MONEY_PRECISION - MONEY_SCALE}}(\\.\\d+)?$`),
  'at most the integer digits a round amount holds',
);

export const LEDGER_V1_KEYED_OPERATIONS = ['bet', 'win', 'reverse'] as const;
export type LedgerV1KeyedOperation = (typeof LEDGER_V1_KEYED_OPERATIONS)[number];

export const LEDGER_V1_REFUSAL_REASONS = [
  'fingerprint_mismatch',
  'invalid_amount',
  'insufficient_funds',
  'player_blocked',
  'ledger_unavailable',
  'limit',
  'max_bet_exceeded',
  'unknown_game',
  'unknown_product',
  'round_mismatch',
  'wallet_not_found',
  'bet_not_found',
  'already_reversed',
] as const;
export const LedgerV1RefusalReasonSchema = z.enum(LEDGER_V1_REFUSAL_REASONS);
export type LedgerV1RefusalReason = z.infer<typeof LedgerV1RefusalReasonSchema>;

const ledgerKey = {
  providerName: LedgerProviderNameSchema,
  providerRefId: LedgerProviderRefSchema,
};

const roundRef = {
  userId: UuidSchema,
  gameId: UuidSchema,
  externalRoundId: LedgerProviderRefSchema,
  currency: CurrencyTickerInputSchema,
};

export const LedgerV1WagerSchema = z
  .object({
    product: WagerProductSchema.optional(),
    rtp: z.string().refine(isWagerRtp, 'decimal fraction in [0, 1]').optional(),
    categorySlug: z.string().trim().min(1).max(128).optional(),
    providerGameKey: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const LedgerV1BetArgsSchema = z.object({
  ...ledgerKey,
  ...roundRef,
  amount: LedgerAmountSchema,
  reverseRef: LedgerProviderRefSchema.optional(),
  wager: LedgerV1WagerSchema.optional(),
});
export type LedgerV1BetArgs = z.input<typeof LedgerV1BetArgsSchema>;

export const LedgerV1WinArgsSchema = z.object({
  ...ledgerKey,
  ...roundRef,
  amount: LedgerAmountSchema,
  isFinal: z.boolean().optional(),
});
export type LedgerV1WinArgs = z.input<typeof LedgerV1WinArgsSchema>;

export const LedgerV1ReverseArgsSchema = z.object({
  ...ledgerKey,
  userId: UuidSchema,
  gameId: UuidSchema,
  targetRefId: LedgerProviderRefSchema,
  externalRoundId: LedgerProviderRefSchema.optional(),
});
export type LedgerV1ReverseArgs = z.input<typeof LedgerV1ReverseArgsSchema>;

export const LedgerV1CloseRoundArgsSchema = z.object(roundRef);
export type LedgerV1CloseRoundArgs = z.input<typeof LedgerV1CloseRoundArgsSchema>;

export const LedgerV1BalanceArgsSchema = z.object({
  userId: UuidSchema,
  currency: CurrencyTickerInputSchema,
});
export type LedgerV1BalanceArgs = z.input<typeof LedgerV1BalanceArgsSchema>;

export const LedgerV1MoveSchema = z.object({
  transactionId: UuidSchema.nullable(),
  reversalTransactionId: UuidSchema.nullable(),
  roundId: UuidSchema,
  balance: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
});
export type LedgerV1Move = z.infer<typeof LedgerV1MoveSchema>;

export const LedgerV1RefusedSchema = z.object({
  status: z.literal('refused'),
  reason: LedgerV1RefusalReasonSchema,
  available: MoneyAmountSchema.optional(),
});
export type LedgerV1Refused = z.infer<typeof LedgerV1RefusedSchema>;

export const LedgerV1MoveOutcomeSchema = z.discriminatedUnion('status', [
  LedgerV1MoveSchema.extend({ status: z.enum(['applied', 'replayed']) }),
  LedgerV1RefusedSchema,
]);
export type LedgerV1MoveOutcome = z.infer<typeof LedgerV1MoveOutcomeSchema>;

export const LedgerV1RoundSchema = z.object({
  roundId: UuidSchema,
  betAmount: MoneyAmountSchema,
  winAmount: MoneyAmountSchema,
});
export type LedgerV1Round = z.infer<typeof LedgerV1RoundSchema>;

export const LedgerV1CloseRoundOutcomeSchema = z.discriminatedUnion('status', [
  LedgerV1RoundSchema.extend({ status: z.literal('closed') }),
  LedgerV1RefusedSchema,
]);
export type LedgerV1CloseRoundOutcome = z.infer<typeof LedgerV1CloseRoundOutcomeSchema>;

export const LedgerV1BalanceOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), balance: MoneyAmountSchema, currency: CurrencyTickerSchema }),
  z.object({ status: z.literal('refused'), reason: z.literal('wallet_not_found') }),
]);
export type LedgerV1BalanceOutcome = z.infer<typeof LedgerV1BalanceOutcomeSchema>;

export const PlayEligibilitySnapshotSchema = z.object({
  userId: UuidSchema,
  rgBlocked: z.boolean(),
  rgBlockedUntil: TimestampSchema.nullable(),
  isActive: z.boolean(),
  banned: z.boolean(),
  banExpires: TimestampSchema.nullable(),
  status: PlayerStatusSchema.nullable(),
  version: z.number().int().nonnegative(),
});
export type PlayEligibilitySnapshot = z.infer<typeof PlayEligibilitySnapshotSchema>;

export const GATED_LIMIT_TYPES = ['deposit', 'wager'] as const;
export const GATED_LIMIT_PERIODS = ['daily', 'weekly', 'monthly'] as const;

export const RgLimitsSnapshotSchema = z.object({
  userId: UuidSchema,
  version: z.number().int().nonnegative(),
  limits: z.array(
    z.object({
      limitId: UuidSchema,
      type: z.enum(GATED_LIMIT_TYPES),
      period: z.enum(GATED_LIMIT_PERIODS),
      amount: MoneyAmountSchema,
      currency: z.string().min(1).nullable(),
      changedAt: TimestampSchema,
    }),
  ),
});
export type RgLimitsSnapshot = z.infer<typeof RgLimitsSnapshotSchema>;

export const LedgerV1SportsbookReserveArgsSchema = SportsbookReserveArgsSchema;
export const LedgerV1SportsbookConfirmArgsSchema = SportsbookConfirmArgsSchema;
export const LedgerV1SportsbookCancelArgsSchema = SportsbookCancelArgsSchema;
export const LedgerV1SportsbookSettleArgsSchema = SportsbookSettleArgsSchema;
export const LedgerV1SportsbookReopenArgsSchema = SportsbookReopenArgsSchema;

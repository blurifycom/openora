/**
 * Ledger API v1: what a casino provider bridge and the sportsbook send the ledger, and what it
 * answers. Plain, serialisable values only, so the same schemas carry the in-process port and a
 * later HTTP transport. A new field is added optional; anything else is a `v2`.
 */
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

/** Provider name core writes its own internal rounds under; a caller may not take it. */
export const LEDGER_RESERVED_PROVIDER_NAME = 'internal';

/**
 * The bridge's own name, e.g. its overlay plugin id. No `:`, so it can never pose as a
 * `<product>:<provider>` name core derives a wager product from.
 */
export const LedgerProviderNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'lowercase provider key, e.g. acme-games')
  .refine((name) => name !== LEDGER_RESERVED_PROVIDER_NAME, 'reserved provider name');

/** An id the provider minted: a transaction id or a round id. */
export const LedgerProviderRefSchema = z.string().trim().min(1).max(128);

/**
 * A money amount without the leading zeros `MoneyAmountSchema` tolerates: the round adds it as a
 * signed amount, which caps the integer digits, so a longer one is refused `invalid_amount`.
 */
const LedgerAmountSchema = MoneyAmountSchema.regex(
  new RegExp(`^\\d{1,${MONEY_PRECISION - MONEY_SCALE}}(\\.\\d+)?$`),
  'at most the integer digits a round amount holds',
);

/** Operations answered from `ledger_api_request` on a retry. */
export const LEDGER_V1_KEYED_OPERATIONS = ['bet', 'win', 'reverse'] as const;
export type LedgerV1KeyedOperation = (typeof LEDGER_V1_KEYED_OPERATIONS)[number];

export const LEDGER_V1_REFUSAL_REASONS = [
  /** The key was already used by a different request. */
  'fingerprint_mismatch',
  'invalid_amount',
  'insufficient_funds',
  /** Excluded, cooling off or otherwise barred from play. */
  'player_blocked',
  /** A responsible-gambling wager limit. */
  'limit',
  /** Above the max bet of the bonus the stake would draw on. */
  'max_bet_exceeded',
  /** The round ledger has no `ledger_game` row for a game a stake would open a round on. */
  'unknown_game',
  /** Neither the caller nor the catalogue names the round's wager product. */
  'unknown_product',
  /** The round id is a round of another game or player. */
  'round_mismatch',
  'wallet_not_found',
  /** A reverse names a bet the ledger does not hold: record it, and pass it as the bet's `reverseRef`. */
  'bet_not_found',
  /** A reverse names a bet another key already reversed. */
  'already_reversed',
] as const;
export const LedgerV1RefusalReasonSchema = z.enum(LEDGER_V1_REFUSAL_REASONS);
export type LedgerV1RefusalReason = z.infer<typeof LedgerV1RefusalReasonSchema>;

const ledgerKey = {
  providerName: LedgerProviderNameSchema,
  /** The idempotency key, with `providerName`: a retry sends the same one. */
  providerRefId: LedgerProviderRefSchema,
};

const roundRef = {
  userId: UuidSchema,
  gameId: UuidSchema,
  externalRoundId: LedgerProviderRefSchema,
  currency: CurrencyTickerInputSchema,
};

/**
 * What the bridge knows of the variant played. The catalogue's `product` and `rtp` win: the
 * bridge's fill the round's snapshot only where the catalogue has none, and a difference is
 * logged. A later stake never changes the snapshot. `categorySlug` and `providerGameKey` go on
 * each stake's wager context as sent. Strict, so a misspelt key fails rather than vanishing;
 * the other argument objects ignore unknown keys.
 */
export const LedgerV1WagerSchema = z
  .object({
    product: WagerProductSchema.optional(),
    rtp: z.string().refine(isWagerRtp, 'decimal fraction in [0, 1]').optional(),
    categorySlug: z.string().trim().min(1).max(128).optional(),
    providerGameKey: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

/**
 * A stake. `reverseRef` is a rollback the provider sent before this bet reached the ledger (the
 * ledger refused it `bet_not_found`): the stake is taken and returned in one transaction, and the
 * rollback is then answered under its own key as already applied.
 */
export const LedgerV1BetArgsSchema = z.object({
  ...ledgerKey,
  ...roundRef,
  amount: LedgerAmountSchema,
  reverseRef: LedgerProviderRefSchema.optional(),
  wager: LedgerV1WagerSchema.optional(),
});
export type LedgerV1BetArgs = z.input<typeof LedgerV1BetArgsSchema>;

/** A payout; `'0'` records a lost round's result without moving money. `isFinal` closes the round. */
export const LedgerV1WinArgsSchema = z.object({
  ...ledgerKey,
  ...roundRef,
  amount: LedgerAmountSchema,
  isFinal: z.boolean().optional(),
});
export type LedgerV1WinArgs = z.input<typeof LedgerV1WinArgsSchema>;

/** Returns the whole stake of the bet keyed `targetRefId` under the same `providerName`. */
export const LedgerV1ReverseArgsSchema = z.object({
  ...ledgerKey,
  userId: UuidSchema,
  gameId: UuidSchema,
  targetRefId: LedgerProviderRefSchema,
});
export type LedgerV1ReverseArgs = z.input<typeof LedgerV1ReverseArgsSchema>;

/**
 * Ends a round that moves no more money. Unkeyed: closing a closed round changes nothing. An
 * `externalRoundId` the ledger has not seen opens the round empty and closes it, as a provider's
 * end-of-round for a round whose every leg was zero would.
 */
export const LedgerV1CloseRoundArgsSchema = z.object(roundRef);
export type LedgerV1CloseRoundArgs = z.input<typeof LedgerV1CloseRoundArgsSchema>;

export const LedgerV1BalanceArgsSchema = z.object({
  userId: UuidSchema,
  currency: CurrencyTickerInputSchema,
});
export type LedgerV1BalanceArgs = z.input<typeof LedgerV1BalanceArgsSchema>;

/** What a bet, win or reverse answered, stored with its key and returned again on a retry. */
export const LedgerV1MoveSchema = z.object({
  /** The ledger row this move wrote; null for a zero win. */
  transactionId: UuidSchema.nullable(),
  /** The reversal a bet's `reverseRef` wrote; null otherwise. */
  reversalTransactionId: UuidSchema.nullable(),
  roundId: UuidSchema,
  /** The player's real balance in `currency` once the move committed. Bonus funds are not in it. */
  balance: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
});
export type LedgerV1Move = z.infer<typeof LedgerV1MoveSchema>;

export const LedgerV1RefusedSchema = z.object({
  status: z.literal('refused'),
  reason: LedgerV1RefusalReasonSchema,
  /** With `insufficient_funds`: the real balance plus what bonus funds could have covered. */
  available: MoneyAmountSchema.optional(),
});
export type LedgerV1Refused = z.infer<typeof LedgerV1RefusedSchema>;

/** `replayed` is the stored answer to a key already applied with the same request: nothing moved again. */
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

/** Refused `round_mismatch` when the round is another player's, game's or currency's. */
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

/**
 * A user's play eligibility inputs as identity committed them, for the ledger's projection.
 * `version` is the user's own counter, bumped under the user row lock by every writer, so the
 * ledger keeps the highest it has seen and ignores an older one that arrives late.
 */
export const PlayEligibilitySnapshotSchema = z.object({
  userId: UuidSchema,
  rgBlocked: z.boolean(),
  rgBlockedUntil: TimestampSchema.nullable(),
  isActive: z.boolean(),
  banned: z.boolean(),
  banExpires: TimestampSchema.nullable(),
  /** Null for a user without a player profile yet. */
  status: PlayerStatusSchema.nullable(),
  version: z.number().int().nonnegative(),
});
export type PlayEligibilitySnapshot = z.infer<typeof PlayEligibilitySnapshotSchema>;

/** The sportsbook ops keep the sportsbook ledger's own shapes, under the v1 names. */
export const LedgerV1SportsbookReserveArgsSchema = SportsbookReserveArgsSchema;
export const LedgerV1SportsbookConfirmArgsSchema = SportsbookConfirmArgsSchema;
export const LedgerV1SportsbookCancelArgsSchema = SportsbookCancelArgsSchema;
export const LedgerV1SportsbookSettleArgsSchema = SportsbookSettleArgsSchema;
export const LedgerV1SportsbookReopenArgsSchema = SportsbookReopenArgsSchema;

/**
 * Deposit turnover requirement: real money credited to a player must be wagered a configured
 * number of times, valued in the pivot currency, before it may leave by withdrawal or transfer.
 * Wallet-internal (ADR-0065); this file holds the shapes other modules and clients read.
 */
import * as z from 'zod';
import { MoneyAmountSchema, TimestampSchema, UuidSchema } from '../schemas/common.js';

export const TURNOVER_CREDIT_TYPES = ['deposit', 'swap_in', 'gift', 'rain', 'donation'] as const;
export const TurnoverCreditTypeSchema = z.enum(TURNOVER_CREDIT_TYPES);
export type TurnoverCreditType = z.infer<typeof TurnoverCreditTypeSchema>;

export const TURNOVER_ENTRY_SOURCES = [...TURNOVER_CREDIT_TYPES, 'grant_conversion'] as const;
export const TurnoverEntrySourceSchema = z.enum(TURNOVER_ENTRY_SOURCES);
export type TurnoverEntrySource = z.infer<typeof TurnoverEntrySourceSchema>;

export const TURNOVER_ENTRY_STATUSES = ['counted', 'pending', 'cleared'] as const;
export const TurnoverEntryStatusSchema = z.enum(TURNOVER_ENTRY_STATUSES);
export type TurnoverEntryStatus = z.infer<typeof TurnoverEntryStatusSchema>;

/** How a ledger row's `turnover_contribution` counts: now, at the round's settlement, or as a reversal. */
export const TURNOVER_STAKE_STATES = ['counted', 'deferred', 'reversal'] as const;
export type TurnoverStakeState = (typeof TURNOVER_STAKE_STATES)[number];

export const TURNOVER_OUTFLOWS = ['withdrawal', 'transfer'] as const;
export type TurnoverOutflow = (typeof TURNOVER_OUTFLOWS)[number];

export const TurnoverSummarySchema = z.object({
  enabled: z.boolean(),
  pivotCurrency: z.string(),
  required: MoneyAmountSchema,
  progress: MoneyAmountSchema,
  remaining: MoneyAmountSchema,
  dustThreshold: MoneyAmountSchema,
  locked: z.boolean(),
  pendingCount: z.number().int().nonnegative(),
  updatedAt: TimestampSchema.nullable(),
});
export type TurnoverSummary = z.infer<typeof TurnoverSummarySchema>;

export const TurnoverEntrySchema = z.object({
  id: UuidSchema,
  source: TurnoverEntrySourceSchema,
  currency: z.string(),
  amount: MoneyAmountSchema,
  multiplier: MoneyAmountSchema,
  pivotValue: MoneyAmountSchema.nullable(),
  required: MoneyAmountSchema.nullable(),
  status: TurnoverEntryStatusSchema,
  createdAt: TimestampSchema,
  pricedAt: TimestampSchema.nullable(),
  clearedAt: TimestampSchema.nullable(),
});
export type TurnoverEntry = z.infer<typeof TurnoverEntrySchema>;

export const AdminTurnoverEntrySchema = TurnoverEntrySchema.extend({
  clearedBy: UuidSchema.nullable(),
  clearReason: z.string().nullable(),
});
export type AdminTurnoverEntry = z.infer<typeof AdminTurnoverEntrySchema>;

export type TurnoverLockedData = {
  reason: 'turnover_requirement_unmet';
  outflow: TurnoverOutflow;
  pivotCurrency: string;
  required: string;
  progress: string;
  remaining: string;
  /** An entry is still unpriced, so the requirement is not known yet. */
  pending: boolean;
};

/** The outflow would move money while the turnover requirement is unmet. The router answers CONFLICT. */
export class TurnoverLockedError extends Error {
  readonly data: TurnoverLockedData;

  constructor(message: string, data: Omit<TurnoverLockedData, 'reason'>) {
    super(message);
    this.name = 'TurnoverLockedError';
    this.data = { reason: 'turnover_requirement_unmet', ...data };
  }
}

/**
 * A requirement was asked for while `wallet.turnover.multiplier` is '0'. Thrown out of
 * `WalletCommands.addTurnoverRequirement`; no router maps it, so a caller answers its own refusal.
 */
export class TurnoverDisabledError extends Error {
  constructor() {
    super('the turnover requirement is off');
    this.name = 'TurnoverDisabledError';
  }
}

/**
 * One balance's lock figures under both locks: the stricter of the two, never their sum. While
 * turnover is locked the whole balance is locked; `bonusLocked` is the bonus lock alone.
 */
export function withTurnoverLock<T extends { balance: string }>(
  row: T,
  bonus: { locked: string; free: string },
  turnoverLocked: boolean,
): T & { locked: string; free: string; bonusLocked: string } {
  return turnoverLocked
    ? { ...row, locked: row.balance, free: '0', bonusLocked: bonus.locked }
    : { ...row, ...bonus, bonusLocked: bonus.locked };
}

export type AddTurnoverRequirementArgs = {
  userId: string;
  currency: string;
  requiredInCurrency: string;
  source: 'grant_conversion';
  sourceRef: string;
};

export type AddTurnoverRequirementResult = {
  entryId: string;
  /** `cleared` only on a replay of an entry staff have since cleared. */
  status: TurnoverEntryStatus;
  replayed: boolean;
};

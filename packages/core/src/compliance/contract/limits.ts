import * as z from 'zod';
import {
  UuidSchema,
  TimestampSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
  LimitChangeKindSchema,
  MoneyAmountSchema,
} from '@openora/core/contracts';

// Shared leaf so both the limit routes (index.ts) and the RG routes (rg.ts) derive
// from one wire shape without a contract cycle.
//
// A limit's threshold is polymorphic by `type`: money-type limits (deposit/wager/loss)
// carry `amount`; the session-time limit carries `minutes`. A full discriminated
// union balloons across contract + schema + service for two variants, so this is the
// documented fallback (PR3 note) - both fields nullable, exactly one set, enforced by
// `isConsistentLimitAmount` below.
export const LimitSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: LimitTypeSchema,
  amount: MoneyAmountSchema.nullable(),
  minutes: z.number().int().positive().nullable(),
  period: LimitPeriodSchema,
  createdAt: TimestampSchema,
});
export type Limit = z.infer<typeof LimitSchema>;

// A session-time limit is the only limit that uses the 'session' period, and it is
// the only thing that period is for. Keep the two in lockstep so an unenforceable
// row (eg deposit/session or session/daily) can never be written.
export const isConsistentLimit = (v: { type: string; period: string }) =>
  (v.type === 'session') === (v.period === 'session');

// The session type carries `minutes`, never `amount`; every other type carries
// `amount`, never `minutes`.
export const isConsistentLimitAmount = (v: {
  type: string;
  amount: string | null;
  minutes: number | null;
}) =>
  v.type === 'session'
    ? v.minutes !== null && v.amount === null
    : v.amount !== null && v.minutes === null;

export const UpsertLimitInputSchema = LimitSchema.pick({
  type: true,
  amount: true,
  minutes: true,
  period: true,
})
  .refine(isConsistentLimit, {
    message: "type 'session' requires period 'session' and vice versa",
    path: ['period'],
  })
  .refine(isConsistentLimitAmount, {
    message: "type 'session' requires minutes (not amount); other types require amount",
    path: ['amount'],
  });
export type UpsertLimitInput = z.infer<typeof UpsertLimitInputSchema>;

/**
 * A limit as both the player and the compliance officer need to see it: the effective
 * limit, how much of it the current period window has already consumed, and any
 * pending request to weaken it.
 *
 * `amount` is ALWAYS the limit in force. A pending increase does not move it - the
 * player is still held to the old value until they confirm - so a UI that shows
 * `pendingAmount` must say so, or the player will read a rejected deposit as a bug.
 *
 * `used`/`remaining`/`pct` are null for the session-time limit, which is measured in
 * minutes by the session sweep rather than in money.
 */
// `user_limit.amount` is numeric(18,2); `used`/`remaining` are derived from a
// MONEY_SCALE(18) ledger sum in the service and rounded to this scale before they reach
// the wire (see rg-self-service.service.ts). MoneyAmountSchema alone allows up to 18
// decimal places and would silently accept an unrounded value here - this is the tighter
// bound the RG limit's own scale actually requires.
const LimitMoneyAmountSchema = MoneyAmountSchema.regex(
  /^\d+(\.\d{1,2})?$/,
  'must have at most 2 decimal places',
);

export const LimitViewSchema = LimitSchema.extend({
  /** Money spent against this limit inside the current period window. */
  used: LimitMoneyAmountSchema.nullable(),
  /** Clamped at zero: an over-limit player has none left, not a negative allowance. */
  remaining: LimitMoneyAmountSchema.nullable(),
  /** `used` as a percentage of the limit; may exceed 100. */
  pct: z.number().nullable(),
  pendingKind: LimitChangeKindSchema.nullable(),
  pendingAmount: MoneyAmountSchema.nullable(),
  pendingMinutes: z.number().int().positive().nullable(),
  /**
   * Never `'expired'` on the wire: a lapsed request reads as no request at all, so no
   * client has to know that state exists. See `pendingChangeStatus`.
   */
  pendingStatus: z.enum(['waiting', 'ready']).nullable(),
  pendingEffectiveAt: TimestampSchema.nullable(),
  pendingExpiresAt: TimestampSchema.nullable(),
});
export type LimitView = z.infer<typeof LimitViewSchema>;

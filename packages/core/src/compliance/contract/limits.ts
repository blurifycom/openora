import * as z from 'zod';
import {
  UuidSchema,
  TimestampSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
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

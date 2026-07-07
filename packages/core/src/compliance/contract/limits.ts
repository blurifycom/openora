import * as z from 'zod';
import {
  UuidSchema,
  TimestampSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
} from '@blurifycom/core/contracts';

// Shared leaf so both the limit routes (index.ts) and the RG routes (rg.ts) derive
// from one wire shape without a contract cycle.
export const LimitSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: LimitTypeSchema,
  amount: z.number(),
  period: LimitPeriodSchema,
  createdAt: TimestampSchema,
});
export type Limit = z.infer<typeof LimitSchema>;

// A session-time limit is the only limit that uses the 'session' period, and it is
// the only thing that period is for. Keep the two in lockstep so an unenforceable
// row (eg deposit/session or session/daily) can never be written.
export const isConsistentLimit = (v: { type: string; period: string }) =>
  (v.type === 'session') === (v.period === 'session');

export const UpsertLimitInputSchema = LimitSchema.pick({
  type: true,
  amount: true,
  period: true,
}).refine(isConsistentLimit, {
  message: "type 'session' requires period 'session' and vice versa",
  path: ['period'],
});
export type UpsertLimitInput = z.infer<typeof UpsertLimitInputSchema>;

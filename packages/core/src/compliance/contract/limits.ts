import * as z from 'zod';
import {
  UuidSchema,
  TimestampSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
  LimitChangeKindSchema,
  MoneyAmountSchema,
  CurrencyTickerSchema,
  CurrencyTickerInputSchema,
} from '@openora/core/contracts';

export const LimitSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: LimitTypeSchema,
  amount: MoneyAmountSchema.nullable(),
  minutes: z.number().int().positive().nullable(),
  currency: CurrencyTickerSchema.nullable(),
  period: LimitPeriodSchema,
  createdAt: TimestampSchema,
});
export type Limit = z.infer<typeof LimitSchema>;

export const isConsistentLimit = (v: { type: string; period: string }) =>
  (v.type === 'session') === (v.period === 'session');

export const isConsistentLimitAmount = (v: {
  type: string;
  amount: string | null;
  minutes: number | null;
}) =>
  v.type === 'session'
    ? v.minutes !== null && v.amount === null
    : v.amount !== null && v.minutes === null;

export const isConsistentLimitCurrency = (v: { type: string; currency: string | null }) =>
  v.type === 'session' ? v.currency === null : v.currency !== null;

type LimitConsistencyInput = {
  type: string;
  amount: string | null;
  minutes: number | null;
  currency: string | null;
  period: string;
};

export const withLimitConsistencyRefinements = <T extends z.ZodType<LimitConsistencyInput>>(
  schema: T,
): T =>
  schema
    .refine(isConsistentLimit, {
      message: "type 'session' requires period 'session' and vice versa",
      path: ['period'],
    })
    .refine(isConsistentLimitAmount, {
      message: "type 'session' requires minutes (not amount); other types require amount",
      path: ['amount'],
    })
    .refine(isConsistentLimitCurrency, {
      message: "type 'session' requires no currency; other types require one",
      path: ['currency'],
    });

export const UpsertLimitInputSchema = withLimitConsistencyRefinements(
  LimitSchema.pick({
    type: true,
    amount: true,
    minutes: true,
    currency: true,
    period: true,
  }).extend({ currency: CurrencyTickerInputSchema.nullable() }),
);
export type UpsertLimitInput = z.infer<typeof UpsertLimitInputSchema>;

export const LimitViewSchema = LimitSchema.extend({
  used: MoneyAmountSchema.nullable(),
  remaining: MoneyAmountSchema.nullable(),
  pct: z.number().nullable(),
  pendingKind: LimitChangeKindSchema.nullable(),
  pendingAmount: MoneyAmountSchema.nullable(),
  pendingMinutes: z.number().int().positive().nullable(),
  pendingCurrency: CurrencyTickerSchema.nullable(),
  pendingStatus: z.enum(['waiting', 'ready']).nullable(),
  pendingEffectiveAt: TimestampSchema.nullable(),
  pendingExpiresAt: TimestampSchema.nullable(),
});
export type LimitView = z.infer<typeof LimitViewSchema>;

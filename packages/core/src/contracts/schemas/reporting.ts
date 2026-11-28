import { z } from 'zod';
import { MoneyAmountSchema, TimestampSchema } from './common.js';

const DateRangeShapeSchema = z.object({
  dateFrom: TimestampSchema.optional(),
  dateTo: TimestampSchema.optional(),
});
export type DateRange = z.infer<typeof DateRangeShapeSchema>;

export function isDateRangeOrdered(range: DateRange): boolean {
  return !range.dateFrom || !range.dateTo || new Date(range.dateFrom) <= new Date(range.dateTo);
}

export const DateRangeSchema = DateRangeShapeSchema.refine(
  isDateRangeOrdered,
  'dateFrom must be before or equal to dateTo',
);

export const GRANULARITIES = ['day', 'week', 'month'] as const;
export const GranularitySchema = z.enum(GRANULARITIES);
export type Granularity = z.infer<typeof GranularitySchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

export type DayRange = { dateFrom: string; dateTo: string };
export type DayRangeInput = Partial<DayRange>;

const isoDay = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

export function resolveDayRange(
  { dateFrom, dateTo }: DayRangeInput,
  defaultDays: number,
  now: Date,
): DayRange {
  const to = dateTo ?? isoDay(now.getTime());
  return {
    dateFrom: dateFrom ?? isoDay(Date.parse(to) - (defaultDays - 1) * DAY_MS),
    dateTo: to,
  };
}

export type DayRangeKeys = { from: string; to: string };

const DATE_RANGE_KEYS: DayRangeKeys = { from: 'dateFrom', to: 'dateTo' };

function refuseUnordered(keys: DayRangeKeys, ctx: z.core.$RefinementCtx) {
  ctx.addIssue({
    code: 'custom',
    path: [keys.from],
    message: `${keys.from} must be on or before ${keys.to}`,
  });
}

export function checkDayRange(
  range: DayRange,
  maxDays: number,
  ctx: z.core.$RefinementCtx,
  keys: DayRangeKeys = DATE_RANGE_KEYS,
) {
  if (range.dateFrom > range.dateTo) {
    refuseUnordered(keys, ctx);
    return;
  }
  if ((Date.parse(range.dateTo) - Date.parse(range.dateFrom)) / DAY_MS + 1 > maxDays) {
    ctx.addIssue({
      code: 'custom',
      path: [keys.from],
      message: `the range spans at most ${maxDays} days`,
    });
  }
}

export function checkDayBounds(
  from: string | undefined,
  to: string | undefined,
  keys: DayRangeKeys,
  ctx: z.core.$RefinementCtx,
) {
  if (from !== undefined && to !== undefined && from > to) {
    refuseUnordered(keys, ctx);
  }
}

export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function dayEnd(day: string): Date {
  return new Date(`${day}T23:59:59.999Z`);
}

export function dayRangeInstants({ dateFrom, dateTo }: DayRange): { from: Date; to: Date } {
  return { from: dayStart(dateFrom), to: dayEnd(dateTo) };
}

export const FIND_TOOL_MAX_LIMIT = 50;

export const FindToolLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(FIND_TOOL_MAX_LIMIT)
  .default(20);

export const MoneyThresholdSchema = MoneyAmountSchema.max(40);

export function countGranularityBuckets(from: Date, to: Date, granularity: Granularity): number {
  if (granularity === 'month') {
    return (
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
      (to.getUTCMonth() - from.getUTCMonth()) +
      1
    );
  }
  const epochDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);
  if (granularity === 'day') {
    return epochDay(to) - epochDay(from) + 1;
  }
  const epochWeek = (d: Date) => Math.floor((epochDay(d) + 3) / 7);
  return epochWeek(to) - epochWeek(from) + 1;
}

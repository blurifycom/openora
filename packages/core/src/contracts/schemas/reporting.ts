import { z } from 'zod';
import { TimestampSchema } from './common.js';

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

/** The whole UTC days a report covers, both ends inclusive, as `YYYY-MM-DD`. */
export type DayRange = { dateFrom: string; dateTo: string };
export type DayRangeInput = Partial<DayRange>;

const isoDay = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

/**
 * The days a report covers: `dateTo` defaults to the day of `now`, and `dateFrom` to the
 * `defaultDays` days ending on `dateTo`.
 */
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

/** A schema refinement: refuses a range that ends before it starts or spans over `maxDays` days. */
export function checkDayRange(range: DayRange, maxDays: number, ctx: z.core.$RefinementCtx) {
  if (range.dateFrom > range.dateTo) {
    ctx.addIssue({
      code: 'custom',
      path: ['dateFrom'],
      message: 'dateFrom must be on or before dateTo',
    });
    return;
  }
  if ((Date.parse(range.dateTo) - Date.parse(range.dateFrom)) / DAY_MS + 1 > maxDays) {
    ctx.addIssue({
      code: 'custom',
      path: ['dateFrom'],
      message: `the range spans at most ${maxDays} days`,
    });
  }
}

/** The instants a day range covers: from the start of `dateFrom` through the end of `dateTo`. */
export function dayRangeInstants({ dateFrom, dateTo }: DayRange): { from: Date; to: Date } {
  return {
    from: new Date(`${dateFrom}T00:00:00.000Z`),
    to: new Date(`${dateTo}T23:59:59.999Z`),
  };
}

/**
 * Buckets `date_trunc(granularity, ...)` yields for from..to in UTC, both ends included.
 * Weeks are ISO weeks starting on Monday. Expects from <= to.
 */
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
  // The epoch (1970-01-01) was a Thursday; shifting by 3 days puts every Monday on a multiple of 7.
  const epochWeek = (d: Date) => Math.floor((epochDay(d) + 3) / 7);
  return epochWeek(to) - epochWeek(from) + 1;
}

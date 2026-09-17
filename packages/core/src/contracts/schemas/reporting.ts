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

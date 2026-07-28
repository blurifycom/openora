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

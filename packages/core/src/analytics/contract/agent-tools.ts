import * as z from 'zod';
import { CurrencyTickerSchema, GranularitySchema, defineMcpTool } from '@openora/core/contracts';
import { GgrSeriesSchema } from './financial.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const GGR_SUMMARY_DEFAULT_DAYS = 30;
export const GGR_SUMMARY_MAX_DAYS = 366;

const isoDay = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

/**
 * The whole UTC days a ggr.summary call covers, both ends inclusive: `dateTo` defaults to the
 * day of `now`, and `dateFrom` to the 30 days ending on `dateTo`.
 */
export function resolveGgrSummaryRange(
  { dateFrom, dateTo }: { dateFrom?: string; dateTo?: string },
  now = new Date(),
) {
  const to = dateTo ?? isoDay(now.getTime());
  return {
    dateFrom: dateFrom ?? isoDay(Date.parse(to) - (GGR_SUMMARY_DEFAULT_DAYS - 1) * DAY_MS),
    dateTo: to,
  };
}

function ggrSummaryRangeDays({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  return (Date.parse(dateTo) - Date.parse(dateFrom)) / DAY_MS + 1;
}

export const GgrSummaryInputSchema = z
  .object({
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    granularity: GranularitySchema.default('week'),
  })
  .superRefine((input, ctx) => {
    const range = resolveGgrSummaryRange(input);
    if (range.dateFrom > range.dateTo) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateFrom'],
        message: 'dateFrom must be on or before dateTo',
      });
      return;
    }
    if (ggrSummaryRangeDays(range) > GGR_SUMMARY_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateFrom'],
        message: `the range spans at most ${GGR_SUMMARY_MAX_DAYS} days`,
      });
    }
  });
export type GgrSummaryInput = z.infer<typeof GgrSummaryInputSchema>;

export const GgrSummaryOutputSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  granularity: GranularitySchema,
  series: z.array(GgrSeriesSchema.extend({ currency: CurrencyTickerSchema })),
});
export type GgrSummary = z.infer<typeof GgrSummaryOutputSchema>;

export const ggrSummaryTool = defineMcpTool({
  id: 'ggr.summary',
  title: 'GGR summary',
  description:
    'Operator-wide gross gaming revenue - completed bets minus bet reversals minus wins - per ' +
    'currency, in day, week or month buckets over whole UTC days from dateFrom through dateTo. ' +
    'Defaults to the 30 days ending today; a range spans at most 366 days. Amounts are decimal ' +
    'strings and can be negative.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'analytics', action: 'view' },
  inputSchema: GgrSummaryInputSchema,
  outputSchema: GgrSummaryOutputSchema,
  redact: { allow: ['dateFrom', 'dateTo', 'granularity', 'series'] },
  errors: [],
});

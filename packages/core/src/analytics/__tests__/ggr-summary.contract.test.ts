import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
  GGR_SUMMARY_MAX_DAYS,
  GgrSummaryInputSchema,
  resolveGgrSummaryRange,
} from '../contract/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-15T12:00:00Z');

const dayOffset = (day: string, days: number) =>
  new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

describe('resolveGgrSummaryRange', () => {
  it('defaults to the 30 days ending on the day of now', () => {
    expect(resolveGgrSummaryRange({}, NOW)).toEqual({
      dateFrom: '2026-02-14',
      dateTo: '2026-03-15',
    });
  });

  it('ends a range with only a start on the day of now', () => {
    expect(resolveGgrSummaryRange({ dateFrom: '2026-03-01' }, NOW)).toEqual({
      dateFrom: '2026-03-01',
      dateTo: '2026-03-15',
    });
  });

  it('starts a range with only an end 30 days before it, across a leap day', () => {
    expect(resolveGgrSummaryRange({ dateTo: '2024-03-10' }, NOW)).toEqual({
      dateFrom: '2024-02-10',
      dateTo: '2024-03-10',
    });
  });

  it('keeps an explicit range as given', () => {
    expect(resolveGgrSummaryRange({ dateFrom: '2025-01-01', dateTo: '2025-06-30' }, NOW)).toEqual({
      dateFrom: '2025-01-01',
      dateTo: '2025-06-30',
    });
  });
});

describe('GgrSummaryInputSchema', () => {
  const parse = (input: unknown) => z.safeParse(GgrSummaryInputSchema, input);

  it('defaults the granularity to week', () => {
    expect(parse({})).toEqual({ success: true, data: { granularity: 'week' } });
  });

  it(`accepts a range of exactly ${GGR_SUMMARY_MAX_DAYS} days`, () => {
    const dateFrom = '2024-01-01';

    expect(parse({ dateFrom, dateTo: dayOffset(dateFrom, GGR_SUMMARY_MAX_DAYS - 1) }).success).toBe(
      true,
    );
  });

  it(`refuses a range longer than ${GGR_SUMMARY_MAX_DAYS} days`, () => {
    const dateFrom = '2024-01-01';

    const result = parse({ dateFrom, dateTo: dayOffset(dateFrom, GGR_SUMMARY_MAX_DAYS) });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['dateFrom']]);
  });

  it('refuses a start that alone reaches further back than the longest range', () => {
    expect(parse({ dateFrom: dayOffset(today(), -GGR_SUMMARY_MAX_DAYS) }).success).toBe(false);
    expect(parse({ dateFrom: dayOffset(today(), 1 - GGR_SUMMARY_MAX_DAYS) }).success).toBe(true);
  });

  it('refuses a range that ends before it starts', () => {
    const result = parse({ dateFrom: '2026-03-15', dateTo: '2026-03-14' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['dateFrom']]);
  });

  it('refuses a start in the future when the end defaults to today', () => {
    expect(parse({ dateFrom: dayOffset(today(), 1) }).success).toBe(false);
  });

  it('refuses a date that does not exist and a currency that is not a ticker', () => {
    expect(parse({ dateFrom: '2026-02-30' }).success).toBe(false);
    expect(parse({ currency: 'US-DOLLAR' }).success).toBe(false);
  });
});

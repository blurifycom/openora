import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
  FINANCIAL_SUMMARY_MAX_DAYS,
  FinancialSummaryInputSchema,
  PAYMENTS_FLOW_MAX_DAYS,
  PaymentsFlowInputSchema,
  resolveFinancialSummaryRange,
  resolvePaymentsFlowRange,
} from '../contract/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-15T12:00:00Z');
const RANGE_START = '2024-01-01';

const dayOffset = (day: string, days: number) =>
  new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

describe('payments.flow_daily input', () => {
  const parse = (input: unknown) => z.safeParse(PaymentsFlowInputSchema, input);

  it('defaults to day buckets over the 14 days ending on the day of now', () => {
    expect(parse({})).toEqual({ success: true, data: { granularity: 'day' } });
    expect(resolvePaymentsFlowRange({}, NOW)).toEqual({
      dateFrom: '2026-03-02',
      dateTo: '2026-03-15',
    });
  });

  it(`accepts a range of exactly ${PAYMENTS_FLOW_MAX_DAYS} days and refuses one day more`, () => {
    const longest = { dateFrom: RANGE_START, dateTo: dayOffset(RANGE_START, 91) };
    const tooLong = { dateFrom: RANGE_START, dateTo: dayOffset(RANGE_START, 92) };

    expect(parse(longest).success).toBe(true);
    expect(parse(tooLong).error?.issues.map((issue) => issue.path)).toEqual([['dateFrom']]);
  });

  it('refuses a range that ends before it starts', () => {
    const result = parse({ dateFrom: '2026-03-15', dateTo: '2026-03-14' });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['dateFrom']]);
  });

  it('takes only deposit and withdrawal types, each listed at most once in all', () => {
    expect(parse({ types: ['withdrawal'] }).success).toBe(true);
    expect(parse({ types: ['bet'] }).success).toBe(false);
    expect(parse({ types: [] }).success).toBe(false);
    expect(parse({ types: ['deposit', 'withdrawal', 'deposit'] }).success).toBe(false);
  });

  it('takes wallet transaction statuses only and day or week buckets only', () => {
    expect(parse({ statuses: ['on_hold', 'refunded'] }).success).toBe(true);
    expect(parse({ statuses: ['approved'] }).success).toBe(false);
    expect(parse({ granularity: 'month' }).success).toBe(false);
  });
});

describe('financial.summary input', () => {
  const parse = (input: unknown) => z.safeParse(FinancialSummaryInputSchema, input);

  it('defaults to the 30 days ending on the day of now', () => {
    expect(resolveFinancialSummaryRange({}, NOW)).toEqual({
      dateFrom: '2026-02-14',
      dateTo: '2026-03-15',
    });
  });

  it(`accepts a range of exactly ${FINANCIAL_SUMMARY_MAX_DAYS} days and refuses one day more`, () => {
    const longest = { dateFrom: RANGE_START, dateTo: dayOffset(RANGE_START, 365) };
    const tooLong = { dateFrom: RANGE_START, dateTo: dayOffset(RANGE_START, 366) };

    expect(parse(longest).success).toBe(true);
    expect(parse(tooLong).error?.issues.map((issue) => issue.path)).toEqual([['dateFrom']]);
  });

  it('refuses a currency that is not a ticker', () => {
    expect(parse({ currency: 'US-DOLLAR' }).success).toBe(false);
  });
});

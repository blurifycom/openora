import { describe, expect, it, vi } from 'vitest';
import {
  FINANCIAL_SUMMARY_MAX_DAYS,
  GGR_SUMMARY_MAX_DAYS,
  GgrSummaryInputSchema,
  PAYMENTS_FLOW_MAX_DAYS,
  resolveFinancialSummaryRange,
  resolveGgrSummaryRange,
  resolvePaymentsFlowRange,
} from '../agent-tools.js';

const NOW = new Date('2026-03-31T23:59:59.999Z');

describe.each([
  ['resolveGgrSummaryRange', resolveGgrSummaryRange, '2026-03-02'],
  ['resolveFinancialSummaryRange', resolveFinancialSummaryRange, '2026-03-02'],
  ['resolvePaymentsFlowRange', resolvePaymentsFlowRange, '2026-03-18'],
])('%s', (_name, resolve, defaultFrom) => {
  it('ends on the UTC day of now and spans the default days inclusive', () => {
    expect(resolve({}, NOW)).toEqual({ dateFrom: defaultFrom, dateTo: '2026-03-31' });
  });

  it('keeps both days the caller sent', () => {
    expect(resolve({ dateFrom: '2025-01-01', dateTo: '2025-02-01' }, NOW)).toEqual({
      dateFrom: '2025-01-01',
      dateTo: '2025-02-01',
    });
  });

  it('counts the default back from a caller dateTo, not from now', () => {
    const range = resolve({ dateTo: '2025-12-31' }, NOW);
    expect(range.dateTo).toBe('2025-12-31');
    expect(range.dateFrom < '2025-12-31').toBe(true);
    expect(range.dateFrom.startsWith('2025-12')).toBe(true);
  });

  it('keeps a caller dateFrom and defaults dateTo to today', () => {
    expect(resolve({ dateFrom: '2026-03-30' }, NOW)).toEqual({
      dateFrom: '2026-03-30',
      dateTo: '2026-03-31',
    });
  });
});

it('counts back across a year end', () => {
  expect(resolvePaymentsFlowRange({ dateTo: '2026-01-05' })).toEqual({
    dateFrom: '2025-12-23',
    dateTo: '2026-01-05',
  });
});

it('counts back across a leap February', () => {
  expect(resolveGgrSummaryRange({ dateTo: '2028-03-01' })).toEqual({
    dateFrom: '2028-02-01',
    dateTo: '2028-03-01',
  });
});

it('uses the current UTC day when now is omitted', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-01T23:30:00-02:00'));
  try {
    expect(resolveGgrSummaryRange({ dateFrom: '2026-01-01' }).dateTo).toBe('2026-07-02');
  } finally {
    vi.useRealTimers();
  }
});

describe('GgrSummaryInputSchema', () => {
  it.each([
    ['the max span', { dateFrom: '2025-01-01', dateTo: '2026-01-01' }, true],
    ['one day over the max span', { dateFrom: '2024-12-31', dateTo: '2026-01-01' }, false],
    ['a single day', { dateFrom: '2026-01-01', dateTo: '2026-01-01' }, true],
    ['an inverted range', { dateFrom: '2026-01-02', dateTo: '2026-01-01' }, false],
    ['a datetime instead of a day', { dateFrom: '2026-01-01T00:00:00Z' }, false],
    ['an impossible day', { dateFrom: '2026-02-30', dateTo: '2026-03-01' }, false],
  ])('%s is accepted: %s', (_name, input, expected) => {
    expect(GgrSummaryInputSchema.safeParse(input).success).toBe(expected);
  });

  it('caps the ranges at the published maxima', () => {
    expect([GGR_SUMMARY_MAX_DAYS, FINANCIAL_SUMMARY_MAX_DAYS, PAYMENTS_FLOW_MAX_DAYS]).toEqual([
      366, 366, 92,
    ]);
  });
});

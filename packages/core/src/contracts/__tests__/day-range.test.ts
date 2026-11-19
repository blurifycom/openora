import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
  checkDayBounds,
  checkDayRange,
  dayRangeInstants,
  resolveDayRange,
} from '../schemas/reporting.js';

const NOW = new Date('2026-03-10T15:30:00.000Z');

describe('a report day range', () => {
  it('defaults to the days ending on the day of now, both ends counted', () => {
    expect(resolveDayRange({}, 30, NOW)).toEqual({ dateFrom: '2026-02-09', dateTo: '2026-03-10' });
    expect(resolveDayRange({ dateTo: '2026-01-31' }, 1, NOW)).toEqual({
      dateFrom: '2026-01-31',
      dateTo: '2026-01-31',
    });
  });

  it('covers its days from the first millisecond of the first through the last of the last', () => {
    expect(dayRangeInstants({ dateFrom: '2026-01-01', dateTo: '2026-01-31' })).toEqual({
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-01-31T23:59:59.999Z'),
    });
  });

  it('refuses a range that ends before it starts or spans more days than allowed', () => {
    const schema = z
      .object({ dateFrom: z.iso.date(), dateTo: z.iso.date() })
      .superRefine((range, ctx) => checkDayRange(range, 31, ctx));

    expect(schema.safeParse({ dateFrom: '2026-01-01', dateTo: '2026-01-31' }).success).toBe(true);
    expect(schema.safeParse({ dateFrom: '2026-01-01', dateTo: '2026-02-01' }).success).toBe(false);
    expect(schema.safeParse({ dateFrom: '2026-01-02', dateTo: '2026-01-01' }).success).toBe(false);
  });
});

describe('a find filter over whole UTC days', () => {
  const PLACED = { from: 'placedFrom', to: 'placedTo' };

  it('names the fields the caller sent when a range is refused', () => {
    const schema = z
      .object({ placedFrom: z.iso.date(), placedTo: z.iso.date() })
      .superRefine((input, ctx) =>
        checkDayRange({ dateFrom: input.placedFrom, dateTo: input.placedTo }, 31, ctx, PLACED),
      );

    expect(
      schema.safeParse({ placedFrom: '2026-01-02', placedTo: '2026-01-01' }).error?.issues,
    ).toEqual([
      expect.objectContaining({
        path: ['placedFrom'],
        message: 'placedFrom must be on or before placedTo',
      }),
    ]);
    expect(
      schema.safeParse({ placedFrom: '2026-01-01', placedTo: '2026-02-01' }).error?.issues,
    ).toEqual([expect.objectContaining({ path: ['placedFrom'] })]);
  });

  it('leaves either end open, and refuses only a last day before the first', () => {
    const schema = z
      .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
      .superRefine((input, ctx) =>
        checkDayBounds(input.from, input.to, { from: 'from', to: 'to' }, ctx),
      );

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ from: '2026-01-02' }).success).toBe(true);
    expect(schema.safeParse({ to: '2020-01-01' }).success).toBe(true);
    expect(schema.safeParse({ from: '2020-01-01', to: '2026-01-01' }).success).toBe(true);
    expect(schema.safeParse({ from: '2026-01-02', to: '2026-01-01' }).success).toBe(false);
  });
});

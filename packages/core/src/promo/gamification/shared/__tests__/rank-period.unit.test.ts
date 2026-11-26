import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RankPayoutAnchors } from '../../contract/index.js';
import { lastCompletePeriod, openPeriodKey } from '../rank-period.js';

const d = (iso: string) => new Date(iso);
const DAY_MS = 86_400_000;
const anchors = (over: Partial<RankPayoutAnchors> = {}): RankPayoutAnchors => ({
  dailyHour: 0,
  weeklyDay: 1,
  monthlyDay: 1,
  ...over,
});

const anchorArb = fc.record({
  dailyHour: fc.integer({ min: 0, max: 23 }),
  weeklyDay: fc.integer({ min: 1, max: 7 }),
  monthlyDay: fc.integer({ min: 1, max: 28 }),
});
const nowArb = fc.date({
  min: new Date('2019-01-01T00:00:00Z'),
  max: new Date('2032-12-31T00:00:00Z'),
  noInvalidDate: true,
});

describe('lastCompletePeriod daily', () => {
  it.each([
    ['mid day', '2026-03-10T15:30:00Z', 0, '2026-03-09T00:00:00.000Z', '2026-03-10T00:00:00.000Z'],
    [
      'exactly at the anchor closes that period',
      '2026-03-10T00:00:00Z',
      0,
      '2026-03-09T00:00:00.000Z',
      '2026-03-10T00:00:00.000Z',
    ],
    [
      '1ms before the anchor stays in the previous',
      '2026-03-09T23:59:59.999Z',
      0,
      '2026-03-08T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ],
    [
      'before the anchor hour',
      '2026-03-10T04:59:59.999Z',
      5,
      '2026-03-08T05:00:00.000Z',
      '2026-03-09T05:00:00.000Z',
    ],
    [
      'at the anchor hour',
      '2026-03-10T05:00:00Z',
      5,
      '2026-03-09T05:00:00.000Z',
      '2026-03-10T05:00:00.000Z',
    ],
    [
      'across a month end',
      '2026-03-01T00:00:00Z',
      0,
      '2026-02-28T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ],
    [
      'across a year end',
      '2026-01-01T00:00:00Z',
      0,
      '2025-12-31T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ],
    ['leap day', '2028-03-01T00:00:00Z', 0, '2028-02-29T00:00:00.000Z', '2028-03-01T00:00:00.000Z'],
  ])('%s', (_name, now, dailyHour, start, end) => {
    const period = lastCompletePeriod('daily', d(now), anchors({ dailyHour }));
    expect(period.start.toISOString()).toBe(start);
    expect(period.end.toISOString()).toBe(end);
  });

  it('keys the period by the start date and hour', () => {
    expect(
      lastCompletePeriod('daily', d('2026-03-10T15:00:00Z'), anchors({ dailyHour: 7 })).sourceRef,
    ).toBe('rank-daily:2026-03-09T07');
  });
});

describe('lastCompletePeriod weekly', () => {
  it.each([
    [
      'mid week, closing Monday',
      '2026-03-11T12:00:00Z',
      1,
      '2026-03-02T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ],
    [
      'on the closing Monday at the anchor',
      '2026-03-09T00:00:00Z',
      1,
      '2026-03-02T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ],
    [
      '1ms before the closing Monday',
      '2026-03-08T23:59:59.999Z',
      1,
      '2026-02-23T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
    ],
    [
      'closing Sunday (7)',
      '2026-03-11T12:00:00Z',
      7,
      '2026-03-01T00:00:00.000Z',
      '2026-03-08T00:00:00.000Z',
    ],
    [
      'on the closing Sunday after the anchor',
      '2026-03-08T02:00:00Z',
      7,
      '2026-03-01T00:00:00.000Z',
      '2026-03-08T00:00:00.000Z',
    ],
    [
      'across a year end',
      '2026-01-02T00:00:00Z',
      1,
      '2025-12-22T00:00:00.000Z',
      '2025-12-29T00:00:00.000Z',
    ],
  ])('%s', (_name, now, weeklyDay, start, end) => {
    const period = lastCompletePeriod('weekly', d(now), anchors({ weeklyDay }));
    expect(period.start.toISOString()).toBe(start);
    expect(period.end.toISOString()).toBe(end);
  });

  it('keys the period by the start date', () => {
    expect(lastCompletePeriod('weekly', d('2026-03-11T12:00:00Z'), anchors()).sourceRef).toBe(
      'rank-weekly:2026-03-02',
    );
  });
});

describe('lastCompletePeriod monthly', () => {
  it.each([
    [
      'mid month',
      '2026-03-15T00:00:00Z',
      1,
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ],
    [
      'exactly at the anchor',
      '2026-03-01T00:00:00Z',
      1,
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ],
    [
      '1ms before the anchor',
      '2026-02-28T23:59:59.999Z',
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ],
    [
      'before the anchor day this month',
      '2026-03-10T00:00:00Z',
      15,
      '2026-01-15T00:00:00.000Z',
      '2026-02-15T00:00:00.000Z',
    ],
    [
      'anchor day 28 in a leap February',
      '2028-02-29T00:00:00Z',
      28,
      '2028-01-28T00:00:00.000Z',
      '2028-02-28T00:00:00.000Z',
    ],
    [
      'anchor day 28 in a common February',
      '2026-02-28T00:00:00Z',
      28,
      '2026-01-28T00:00:00.000Z',
      '2026-02-28T00:00:00.000Z',
    ],
    [
      'across a year end',
      '2026-01-10T00:00:00Z',
      15,
      '2025-11-15T00:00:00.000Z',
      '2025-12-15T00:00:00.000Z',
    ],
  ])('%s', (_name, now, monthlyDay, start, end) => {
    const period = lastCompletePeriod('monthly', d(now), anchors({ monthlyDay }));
    expect(period.start.toISOString()).toBe(start);
    expect(period.end.toISOString()).toBe(end);
  });

  it('keys the period by the start date', () => {
    expect(lastCompletePeriod('monthly', d('2026-03-15T00:00:00Z'), anchors()).sourceRef).toBe(
      'rank-monthly:2026-02-01',
    );
  });
});

describe('lastCompletePeriod properties', () => {
  const lengthBound = { daily: 1, weekly: 7, monthly: 31 } as const;

  it.each(['daily', 'weekly', 'monthly'] as const)(
    '%s: the period has closed, and only just',
    (kind) => {
      fc.assert(
        fc.property(nowArb, anchorArb, (now, a) => {
          const { start, end } = lastCompletePeriod(kind, now, a);
          expect(end.getTime()).toBeLessThanOrEqual(now.getTime());
          expect(now.getTime() - end.getTime()).toBeLessThan(lengthBound[kind] * DAY_MS + DAY_MS);
          expect(start.getTime()).toBeLessThan(end.getTime());
          expect(end.getUTCHours()).toBe(a.dailyHour);
          expect(end.getUTCMinutes()).toBe(0);
        }),
      );
    },
  );

  it('weekly closes on the anchored weekday and spans 7 days', () => {
    fc.assert(
      fc.property(nowArb, anchorArb, (now, a) => {
        const { start, end } = lastCompletePeriod('weekly', now, a);
        expect(end.getUTCDay() || 7).toBe(a.weeklyDay);
        expect(end.getTime() - start.getTime()).toBe(7 * DAY_MS);
        expect(now.getTime() - end.getTime()).toBeLessThan(7 * DAY_MS);
      }),
    );
  });

  it('monthly closes on the anchored day and starts on the same day of the previous month', () => {
    fc.assert(
      fc.property(nowArb, anchorArb, (now, a) => {
        const { start, end } = lastCompletePeriod('monthly', now, a);
        expect(end.getUTCDate()).toBe(a.monthlyDay);
        expect(start.getUTCDate()).toBe(a.monthlyDay);
        expect(
          end.getUTCFullYear() * 12 +
            end.getUTCMonth() -
            (start.getUTCFullYear() * 12 + start.getUTCMonth()),
        ).toBe(1);
      }),
    );
  });

  it.each(['daily', 'weekly', 'monthly'] as const)(
    '%s: consecutive periods tile with no gap',
    (kind) => {
      fc.assert(
        fc.property(nowArb, anchorArb, (now, a) => {
          const current = lastCompletePeriod(kind, now, a);
          const before = lastCompletePeriod(kind, new Date(current.start.getTime()), a);
          expect(before.end.getTime()).toBe(current.start.getTime());
        }),
      );
    },
  );

  it.each(['daily', 'weekly', 'monthly'] as const)(
    '%s: the open period key is stable until the next close and differs from the closed one',
    (kind) => {
      fc.assert(
        fc.property(nowArb, anchorArb, (now, a) => {
          const closed = lastCompletePeriod(kind, now, a);
          expect(openPeriodKey(kind, now, a)).not.toBe(closed.sourceRef);
          expect(openPeriodKey(kind, closed.end, a)).toBe(openPeriodKey(kind, now, a));
        }),
      );
    },
  );
});

describe('openPeriodKey', () => {
  it.each([
    ['daily', '2026-03-10T15:00:00Z', 'rank-daily:2026-03-10T00'],
    ['weekly', '2026-03-11T12:00:00Z', 'rank-weekly:2026-03-09'],
    ['monthly', '2026-03-15T00:00:00Z', 'rank-monthly:2026-03-01'],
  ] as const)('%s keys the period still being wagered', (kind, now, expected) => {
    expect(openPeriodKey(kind, d(now), anchors())).toBe(expected);
  });

  it('rolls to the next key at the anchor instant', () => {
    expect(openPeriodKey('daily', d('2026-03-10T23:59:59.999Z'), anchors())).toBe(
      'rank-daily:2026-03-10T00',
    );
    expect(openPeriodKey('daily', d('2026-03-11T00:00:00Z'), anchors())).toBe(
      'rank-daily:2026-03-11T00',
    );
  });
});

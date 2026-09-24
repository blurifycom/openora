import { describe, it, expect } from 'vitest';
import { DEFAULT_PAYOUT_ANCHORS } from '../contract/index.js';
import { lastCompletePeriod } from '../shared/rank-period.js';

const at = (iso: string) => new Date(iso);
const anchors = (overrides: Partial<typeof DEFAULT_PAYOUT_ANCHORS> = {}) => ({
  ...DEFAULT_PAYOUT_ANCHORS,
  ...overrides,
});

describe('the last payout period to close', () => {
  it('is yesterday for a daily payout, whatever hour of the day the job runs', () => {
    for (const now of ['2026-09-22T00:00:00Z', '2026-09-22T18:30:00Z', '2026-09-22T23:59:59Z']) {
      expect(lastCompletePeriod('daily', at(now), anchors())).toEqual({
        start: at('2026-09-21T00:00:00Z'),
        end: at('2026-09-22T00:00:00Z'),
        sourceRef: 'rank-daily:2026-09-21T00',
      });
    }
  });

  it('closes the day at the operator-chosen hour, not at midnight', () => {
    const sixAm = anchors({ dailyHour: 6 });

    // Just before 06:00 the day that closed is still the one before.
    expect(lastCompletePeriod('daily', at('2026-09-22T05:59:00Z'), sixAm)).toMatchObject({
      start: at('2026-09-20T06:00:00Z'),
      end: at('2026-09-21T06:00:00Z'),
    });
    expect(lastCompletePeriod('daily', at('2026-09-22T06:00:00Z'), sixAm)).toMatchObject({
      start: at('2026-09-21T06:00:00Z'),
      end: at('2026-09-22T06:00:00Z'),
      sourceRef: 'rank-daily:2026-09-21T06',
    });
  });

  it('runs the week Monday to Monday by default', () => {
    // 2026-09-22 is a Tuesday, so the week that closed ran from Monday the 14th.
    expect(lastCompletePeriod('weekly', at('2026-09-22T10:00:00Z'), anchors())).toEqual({
      start: at('2026-09-14T00:00:00Z'),
      end: at('2026-09-21T00:00:00Z'),
      sourceRef: 'rank-weekly:2026-09-14',
    });
  });

  it('moves the whole week when the operator closes it on a Friday', () => {
    const friday = anchors({ weeklyDay: 5 });

    // Tuesday the 22nd: the last Friday was the 18th, and its week began on the 11th.
    expect(lastCompletePeriod('weekly', at('2026-09-22T10:00:00Z'), friday)).toEqual({
      start: at('2026-09-11T00:00:00Z'),
      end: at('2026-09-18T00:00:00Z'),
      sourceRef: 'rank-weekly:2026-09-11',
    });
  });

  it('is the previous calendar month by default, across a year boundary too', () => {
    expect(lastCompletePeriod('monthly', at('2026-09-01T00:00:00Z'), anchors())).toEqual({
      start: at('2026-08-01T00:00:00Z'),
      end: at('2026-09-01T00:00:00Z'),
      sourceRef: 'rank-monthly:2026-08-01',
    });
    expect(lastCompletePeriod('monthly', at('2027-01-15T00:00:00Z'), anchors())).toMatchObject({
      sourceRef: 'rank-monthly:2026-12-01',
    });
  });

  it('closes the month on the operator-chosen day', () => {
    const fifteenth = anchors({ monthlyDay: 15 });

    expect(lastCompletePeriod('monthly', at('2026-09-20T00:00:00Z'), fifteenth)).toEqual({
      start: at('2026-08-15T00:00:00Z'),
      end: at('2026-09-15T00:00:00Z'),
      sourceRef: 'rank-monthly:2026-08-15',
    });
    // The 10th is before this month's anchor, so the month that closed is the one before.
    expect(lastCompletePeriod('monthly', at('2026-09-10T00:00:00Z'), fifteenth)).toMatchObject({
      start: at('2026-07-15T00:00:00Z'),
      end: at('2026-08-15T00:00:00Z'),
    });
  });

  it('keys a period by the day it began, so two anchors never share one key', () => {
    const monday = lastCompletePeriod('weekly', at('2026-09-22T10:00:00Z'), anchors());
    const friday = lastCompletePeriod(
      'weekly',
      at('2026-09-22T10:00:00Z'),
      anchors({ weeklyDay: 5 }),
    );

    expect(monday.sourceRef).not.toBe(friday.sourceRef);
  });
});

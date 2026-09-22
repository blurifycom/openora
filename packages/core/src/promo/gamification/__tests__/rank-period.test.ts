import { describe, it, expect } from 'vitest';
import { lastCompletePeriod } from '../shared/rank-period.js';

const at = (iso: string) => new Date(iso);

describe('the last complete payout period', () => {
  it('is yesterday for a daily payout, whatever the hour it runs', () => {
    for (const now of ['2026-09-22T00:00:00Z', '2026-09-22T18:30:00Z', '2026-09-22T23:59:59Z']) {
      expect(lastCompletePeriod('daily', at(now))).toEqual({
        start: at('2026-09-21T00:00:00Z'),
        end: at('2026-09-22T00:00:00Z'),
        sourceRef: 'rank-daily:2026-09-21',
      });
    }
  });

  it('is the previous Monday-to-Monday week, keyed by its ISO week', () => {
    // 2026-09-22 is a Tuesday; the week before ran from Monday the 14th.
    expect(lastCompletePeriod('weekly', at('2026-09-22T10:00:00Z'))).toEqual({
      start: at('2026-09-14T00:00:00Z'),
      end: at('2026-09-21T00:00:00Z'),
      sourceRef: 'rank-weekly:2026-W38',
    });
  });

  it('pays the week that just ended when run at Monday midnight and when run on Sunday', () => {
    expect(lastCompletePeriod('weekly', at('2026-09-21T00:00:00Z')).sourceRef).toBe(
      'rank-weekly:2026-W38',
    );
    expect(lastCompletePeriod('weekly', at('2026-09-27T23:00:00Z')).sourceRef).toBe(
      'rank-weekly:2026-W38',
    );
  });

  it('keys a week spanning New Year by the year its Thursday falls in', () => {
    // Monday 2024-12-30 to Sunday 2025-01-05 is ISO week 1 of 2025.
    expect(lastCompletePeriod('weekly', at('2025-01-06T00:00:00Z')).sourceRef).toBe(
      'rank-weekly:2025-W01',
    );
    // Monday 2020-12-28 to Sunday 2021-01-03 is ISO week 53 of 2020.
    expect(lastCompletePeriod('weekly', at('2021-01-04T00:00:00Z')).sourceRef).toBe(
      'rank-weekly:2020-W53',
    );
  });

  it('is the previous calendar month, across a year boundary too', () => {
    expect(lastCompletePeriod('monthly', at('2026-09-01T00:00:00Z'))).toEqual({
      start: at('2026-08-01T00:00:00Z'),
      end: at('2026-09-01T00:00:00Z'),
      sourceRef: 'rank-monthly:2026-08',
    });
    expect(lastCompletePeriod('monthly', at('2027-01-15T00:00:00Z')).sourceRef).toBe(
      'rank-monthly:2026-12',
    );
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import type { StreakRakebackMilestone } from '../../contract/index.js';
import { activeRakebackRate, isoDate, isStreakLive, yesterdayOf } from '../streak-day.js';

const utc = (iso: string) => new Date(iso);

const milestone = (
  day: number,
  unrankedRatePercent: string,
  rankedUpliftPercent: string,
): StreakRakebackMilestone => ({ day, unrankedRatePercent, rankedUpliftPercent });

describe('isoDate and yesterdayOf', () => {
  const originalTz = process.env['TZ'];

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env['TZ'];
    } else {
      process.env['TZ'] = originalTz;
    }
  });

  it('returns the UTC calendar day regardless of the local zone', () => {
    const instant = utc('2026-03-10T23:30:00.000Z');
    const results = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'].map((zone) => {
      process.env['TZ'] = zone;
      return isoDate(instant);
    });
    expect(results).toEqual(['2026-03-10', '2026-03-10', '2026-03-10']);
  });

  it('yesterday of the first of a month is the last day of the previous month', () => {
    expect(yesterdayOf(utc('2026-03-01T00:00:00.000Z'))).toBe('2026-02-28');
    expect(yesterdayOf(utc('2028-03-01T12:00:00.000Z'))).toBe('2028-02-29');
  });

  it('yesterday of the first of January is the thirty-first of December', () => {
    expect(yesterdayOf(utc('2027-01-01T00:00:00.000Z'))).toBe('2026-12-31');
  });
});

describe('isStreakLive', () => {
  const now = utc('2026-11-26T10:00:00.000Z');

  it('is live when the last qualifying day is today', () => {
    expect(isStreakLive('2026-11-26', now)).toBe(true);
  });

  it('is live when the last qualifying day is yesterday', () => {
    expect(isStreakLive('2026-11-25', now)).toBe(true);
  });

  it('is not live when the last qualifying day is two days ago', () => {
    expect(isStreakLive('2026-11-24', now)).toBe(false);
  });

  it('is not live when there is no qualifying day', () => {
    expect(isStreakLive(null, now)).toBe(false);
  });

  it('stays live at 23:59:59 UTC and counts yesterday as of 00:00:00 UTC the next day', () => {
    const lastDay = '2026-11-24';
    expect(isStreakLive(lastDay, utc('2026-11-25T23:59:59.999Z'))).toBe(true);
    expect(isStreakLive(lastDay, utc('2026-11-26T00:00:00.000Z'))).toBe(false);
    expect(isStreakLive('2026-11-25', utc('2026-11-26T00:00:00.000Z'))).toBe(true);
  });
});

describe('activeRakebackRate', () => {
  it('returns null when no milestone is at or below the current day', () => {
    expect(activeRakebackRate([milestone(3, '1', '2')], 2)).toBeNull();
    expect(activeRakebackRate([], 5)).toBeNull();
  });

  it('returns the highest rate among milestones at or below the current day', () => {
    const milestones = [milestone(1, '1', '5'), milestone(3, '2', '10'), milestone(7, '4', '20')];
    expect(activeRakebackRate(milestones, 3)).toEqual({
      unrankedRatePercent: '2',
      rankedUpliftPercent: '10',
    });
    expect(activeRakebackRate(milestones, 7)).toEqual({
      unrankedRatePercent: '4',
      rankedUpliftPercent: '20',
    });
  });

  it('a later milestone with a lower rate never lowers the active rate', () => {
    const milestones = [milestone(1, '3', '10'), milestone(5, '1', '2')];
    expect(activeRakebackRate(milestones, 5)).toEqual({
      unrankedRatePercent: '3',
      rankedUpliftPercent: '10',
    });
  });

  it('picks the unranked and ranked uplift formulas independently', () => {
    const milestones = [milestone(1, '5', '1'), milestone(2, '2', '9')];
    expect(activeRakebackRate(milestones, 2)).toEqual({
      unrankedRatePercent: '5',
      rankedUpliftPercent: '9',
    });
  });
});

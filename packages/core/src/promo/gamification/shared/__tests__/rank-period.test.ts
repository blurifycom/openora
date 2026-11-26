import { describe, expect, it } from 'vitest';
import { RankPayoutAnchorsSchema, type RankPayoutAnchors } from '../../contract/index.js';
import { lastCompletePeriod, openPeriodKey } from '../rank-period.js';

const utc = (iso: string) => new Date(iso);
const anchors = (overrides: Partial<RankPayoutAnchors> = {}): RankPayoutAnchors => ({
  dailyHour: 0,
  weeklyDay: 1,
  monthlyDay: 1,
  ...overrides,
});

describe('lastCompletePeriod', () => {
  it('daily ends at the anchor hour of today when it has passed and of yesterday when not', () => {
    const at6 = anchors({ dailyHour: 6 });
    const passed = lastCompletePeriod('daily', utc('2026-11-26T06:00:00.000Z'), at6);
    expect(passed.end.toISOString()).toBe('2026-11-26T06:00:00.000Z');
    expect(passed.start.toISOString()).toBe('2026-11-25T06:00:00.000Z');

    const notYet = lastCompletePeriod('daily', utc('2026-11-26T05:59:59.999Z'), at6);
    expect(notYet.end.toISOString()).toBe('2026-11-25T06:00:00.000Z');
    expect(notYet.start.toISOString()).toBe('2026-11-24T06:00:00.000Z');
  });

  it('weekly ends on the last anchor weekday at the anchor hour', () => {
    const period = lastCompletePeriod('weekly', utc('2026-11-26T10:00:00.000Z'), anchors());
    expect(period.end.toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(period.start.toISOString()).toBe('2026-11-16T00:00:00.000Z');

    const beforeHour = lastCompletePeriod(
      'weekly',
      utc('2026-11-23T04:59:59.000Z'),
      anchors({ dailyHour: 5 }),
    );
    expect(beforeHour.end.toISOString()).toBe('2026-11-16T05:00:00.000Z');
  });

  it('weekly handles a Sunday anchor and a Monday anchor', () => {
    const now = utc('2026-11-26T10:00:00.000Z');
    expect(lastCompletePeriod('weekly', now, anchors({ weeklyDay: 7 })).end.toISOString()).toBe(
      '2026-11-22T00:00:00.000Z',
    );
    expect(lastCompletePeriod('weekly', now, anchors({ weeklyDay: 1 })).end.toISOString()).toBe(
      '2026-11-23T00:00:00.000Z',
    );
    expect(
      lastCompletePeriod('weekly', utc('2026-11-22T00:00:00.000Z'), anchors({ weeklyDay: 7 })).end,
    ).toEqual(utc('2026-11-22T00:00:00.000Z'));
  });

  it('monthly ends on the anchor day of this month when passed and of the previous month when not', () => {
    const on15 = anchors({ monthlyDay: 15 });
    const passed = lastCompletePeriod('monthly', utc('2026-11-15T00:00:00.000Z'), on15);
    expect(passed.end.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(passed.start.toISOString()).toBe('2026-10-15T00:00:00.000Z');

    const notYet = lastCompletePeriod('monthly', utc('2026-11-14T23:59:59.999Z'), on15);
    expect(notYet.end.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(notYet.start.toISOString()).toBe('2026-09-15T00:00:00.000Z');

    const acrossYear = lastCompletePeriod('monthly', utc('2027-01-10T00:00:00.000Z'), on15);
    expect(acrossYear.end.toISOString()).toBe('2026-12-15T00:00:00.000Z');
    expect(acrossYear.start.toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('monthly anchor day 28 lands on the last day of February and the contract refuses days past 28', () => {
    const period = lastCompletePeriod(
      'monthly',
      utc('2027-02-28T00:00:00.000Z'),
      anchors({ monthlyDay: 28 }),
    );
    expect(period.end.toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(period.start.toISOString()).toBe('2027-01-28T00:00:00.000Z');
    expect(RankPayoutAnchorsSchema.safeParse(anchors({ monthlyDay: 29 })).success).toBe(false);
  });
});

describe('openPeriodKey', () => {
  it('starts where the last complete period ended', () => {
    const now = utc('2026-11-26T10:00:00.000Z');
    expect(openPeriodKey('weekly', now, anchors())).toBe('rank-weekly:2026-11-23');
    expect(openPeriodKey('daily', now, anchors({ dailyHour: 6 }))).toBe('rank-daily:2026-11-26T06');
    expect(openPeriodKey('monthly', now, anchors({ monthlyDay: 15 }))).toBe(
      'rank-monthly:2026-11-15',
    );
  });

  it('a counter written during a period and the payout of that period use the same key', () => {
    const a = anchors({ dailyHour: 6, weeklyDay: 3, monthlyDay: 10 });
    const during = utc('2026-11-26T10:00:00.000Z');
    const afterClose = utc('2026-11-27T06:00:00.000Z');
    expect(openPeriodKey('daily', during, a)).toBe(
      lastCompletePeriod('daily', afterClose, a).sourceRef,
    );
    const weeklyClose = utc('2026-12-02T06:00:00.000Z');
    expect(openPeriodKey('weekly', during, a)).toBe(
      lastCompletePeriod('weekly', weeklyClose, a).sourceRef,
    );
    const monthlyClose = utc('2026-12-10T06:00:00.000Z');
    expect(openPeriodKey('monthly', during, a)).toBe(
      lastCompletePeriod('monthly', monthlyClose, a).sourceRef,
    );
  });

  it('formats daily keys with the hour and weekly and monthly keys with the date', () => {
    const now = utc('2026-11-26T10:00:00.000Z');
    expect(lastCompletePeriod('daily', now, anchors({ dailyHour: 3 })).sourceRef).toBe(
      'rank-daily:2026-11-25T03',
    );
    expect(lastCompletePeriod('weekly', now, anchors()).sourceRef).toBe('rank-weekly:2026-11-16');
    expect(lastCompletePeriod('monthly', now, anchors()).sourceRef).toBe('rank-monthly:2026-10-01');
  });
});

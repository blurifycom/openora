import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyCompare, moneyEquals } from '@openora/core/server';
import { activeRakebackRate, isStreakLive, yesterdayOf } from '../streak-day.js';

const d = (iso: string) => new Date(iso);

describe('isStreakLive', () => {
  it.each([
    ['null', null, '2026-03-10T12:00:00Z', false],
    ['today', '2026-03-10', '2026-03-10T12:00:00Z', true],
    ['yesterday', '2026-03-09', '2026-03-10T12:00:00Z', true],
    ['two days ago', '2026-03-08', '2026-03-10T12:00:00Z', false],
    ['tomorrow', '2026-03-11', '2026-03-10T12:00:00Z', false],
    ['yesterday at the first ms of today', '2026-03-09', '2026-03-10T00:00:00.000Z', true],
    ['yesterday at the last ms of today', '2026-03-09', '2026-03-10T23:59:59.999Z', true],
    [
      'the day before yesterday at the first ms of today',
      '2026-03-08',
      '2026-03-10T00:00:00.000Z',
      false,
    ],
    [
      'yesterday just before midnight turned it two days old',
      '2026-03-09',
      '2026-03-11T00:00:00.000Z',
      false,
    ],
    ['the day before at the last ms of the day', '2026-03-09', '2026-03-10T23:59:59.999Z', true],
    ['across a month end', '2026-02-28', '2026-03-01T08:00:00Z', true],
    ['across a year end', '2025-12-31', '2026-01-01T00:00:00Z', true],
    ['leap day', '2028-02-29', '2028-03-01T10:00:00Z', true],
    ['leap day two days on', '2028-02-29', '2028-03-02T00:00:00Z', false],
  ])('%s', (_name, last, now, expected) => {
    expect(isStreakLive(last, d(now))).toBe(expected);
  });

  it('is live for exactly the day of now and the day before', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2019-01-01T00:00:00Z'),
          max: new Date('2032-12-31T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: -3, max: 3 }),
        (now, offsetDays) => {
          const day = new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
          expect(isStreakLive(day, now)).toBe(offsetDays === 0 || offsetDays === -1);
        },
      ),
    );
  });

  it('yesterdayOf is the UTC date before now', () => {
    expect(yesterdayOf(d('2026-03-01T00:00:00Z'))).toBe('2026-02-28');
  });
});

const milestone = (day: number, unrankedRatePercent: string, rankedUpliftPercent: string) => ({
  day,
  unrankedRatePercent,
  rankedUpliftPercent,
});

describe('activeRakebackRate', () => {
  it('is null with no milestones', () => {
    expect(activeRakebackRate([], 10)).toBeNull();
  });

  it('is null when every milestone is above the current day', () => {
    expect(activeRakebackRate([milestone(3, '1', '1'), milestone(5, '2', '2')], 2)).toBeNull();
  });

  it('counts a milestone exactly at the current day', () => {
    expect(activeRakebackRate([milestone(3, '1.5', '10')], 3)).toEqual({
      unrankedRatePercent: '1.5',
      rankedUpliftPercent: '10',
    });
  });

  it('ignores a milestone one day above the current day', () => {
    expect(activeRakebackRate([milestone(3, '1', '1'), milestone(4, '9', '9')], 3)).toEqual({
      unrankedRatePercent: '1',
      rankedUpliftPercent: '1',
    });
  });

  it('keeps the higher unranked rate when a later row lowers it, and takes the higher uplift', () => {
    expect(activeRakebackRate([milestone(3, '5', '1'), milestone(7, '2', '4')], 7)).toEqual({
      unrankedRatePercent: '5',
      rankedUpliftPercent: '4',
    });
  });

  it('keeps the higher uplift when a later row lowers it, and takes the higher unranked rate', () => {
    expect(activeRakebackRate([milestone(3, '1', '8'), milestone(7, '4', '2')], 7)).toEqual({
      unrankedRatePercent: '4',
      rankedUpliftPercent: '8',
    });
  });

  it('returns the shared value on ties', () => {
    expect(activeRakebackRate([milestone(3, '2.50', '1'), milestone(4, '2.5', '1')], 4)).toSatisfy(
      (rate: { unrankedRatePercent: string; rankedUpliftPercent: string } | null) =>
        rate !== null &&
        moneyEquals(rate.unrankedRatePercent, '2.5') &&
        moneyEquals(rate.rankedUpliftPercent, '1'),
    );
  });

  const percentArb = fc
    .tuple(fc.nat(100), fc.nat(99))
    .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(2, '0')}`);
  const milestonesArb = fc.array(
    fc.record({
      day: fc.integer({ min: 1, max: 30 }),
      unrankedRatePercent: percentArb,
      rankedUpliftPercent: percentArb,
    }),
    { maxLength: 12 },
  );

  it('equals the per-field max over rows at or below the current day, under any order', () => {
    fc.assert(
      fc.property(
        milestonesArb,
        fc.integer({ min: 0, max: 31 }),
        fc.array(fc.nat(), { minLength: 12, maxLength: 12 }),
        (rows, current, entropy) => {
          const reached = rows.filter((row) => row.day <= current);
          const shuffled = rows
            .map((row, index) => ({ row, key: entropy[index] ?? 0 }))
            .sort((a, b) => a.key - b.key)
            .map(({ row }) => row);
          const result = activeRakebackRate(shuffled, current);
          if (reached.length === 0) {
            expect(result).toBeNull();
            return;
          }
          const max = (pick: (row: (typeof reached)[number]) => string) =>
            reached.map(pick).reduce((a, b) => (moneyCompare(b, a) > 0 ? b : a));
          expect(result).not.toBeNull();
          expect(
            moneyEquals(
              result?.unrankedRatePercent ?? '-1',
              max((r) => r.unrankedRatePercent),
            ),
          ).toBe(true);
          expect(
            moneyEquals(
              result?.rankedUpliftPercent ?? '-1',
              max((r) => r.rankedUpliftPercent),
            ),
          ).toBe(true);
        },
      ),
    );
  });
});

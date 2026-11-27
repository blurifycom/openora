import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyAdd, moneyCompare, moneyMultiplyDivide } from '@openora/core/server';
import { upliftWithinEdge } from '../rakeback.service.js';

const tier = (over: {
  rakebackPercent?: string;
  dailyBonusPercent?: string | null;
  weeklyBonusPercent?: string | null;
  monthlyBonusPercent?: string | null;
}) => ({
  rakebackPercent: '25',
  dailyBonusPercent: null,
  weeklyBonusPercent: null,
  monthlyBonusPercent: null,
  ...over,
});

const percent = fc
  .integer({ min: 0, max: 10_000 })
  .map((hundredths) => (hundredths / 100).toFixed(2));

describe('upliftWithinEdge', () => {
  it.each([
    ['an uplift that fits stays whole', tier({}), '100', 'margin', '100'],
    ['an uplift past the edge is trimmed to it', tier({}), '500', 'margin', '300'],
    ['the uplift at the edge exactly stays', tier({}), '300', 'margin', '300'],
    [
      'margin bonuses shrink the headroom',
      tier({ dailyBonusPercent: '25', weeklyBonusPercent: '25' }),
      '500',
      'margin',
      '100',
    ],
    [
      'flat periodic bonuses leave the headroom alone',
      tier({ dailyBonusPercent: '25', weeklyBonusPercent: '25' }),
      '500',
      'flat',
      '300',
    ],
    ['no headroom pays no uplift', tier({ rakebackPercent: '100' }), '10', 'margin', '0'],
    [
      'bonuses already over the edge pay no uplift',
      tier({ rakebackPercent: '50', monthlyBonusPercent: '60' }),
      '10',
      'margin',
      '0',
    ],
    ['zero rakeback pays no uplift', tier({ rakebackPercent: '0' }), '10', 'margin', '0'],
    [
      'the ceiling is floored to two decimals',
      tier({ rakebackPercent: '30' }),
      '999',
      'margin',
      '233.33',
    ],
  ] as const)('%s', (_name, input, uplift, basis, expected) => {
    expect(moneyCompare(upliftWithinEdge(input, uplift, basis), expected)).toBe(0);
  });

  it('never pays rakeback plus margin bonuses over the whole edge', () => {
    fc.assert(
      fc.property(
        percent,
        percent,
        percent,
        percent,
        percent,
        (rake, daily, weekly, monthly, uplift) => {
          const input = tier({
            rakebackPercent: rake,
            dailyBonusPercent: daily,
            weeklyBonusPercent: weekly,
            monthlyBonusPercent: monthly,
          });
          const kept = upliftWithinEdge(input, uplift, 'margin');
          const rakeback = moneyMultiplyDivide(rake, moneyAdd('100', kept), '100');
          const total = [daily, weekly, monthly].reduce(
            (sum, bonus) => moneyAdd(sum, bonus),
            rakeback,
          );
          const bonusesFit =
            moneyCompare(moneyAdd(moneyAdd(rake, daily), moneyAdd(weekly, monthly)), '100') <= 0;
          if (bonusesFit) {
            expect(moneyCompare(total, '100')).toBeLessThanOrEqual(0);
          }
          expect(moneyCompare(kept, uplift)).toBeLessThanOrEqual(0);
          expect(moneyCompare(kept, '0')).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

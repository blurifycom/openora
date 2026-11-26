import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ContributionPercentSchema } from '@openora/core/contracts';
import { paysOverHouseEdge } from '../index.js';

describe('paysOverHouseEdge', () => {
  it.each([
    [
      'all four at zero',
      {
        rakebackPercent: '0',
        dailyBonusPercent: '0',
        weeklyBonusPercent: '0',
        monthlyBonusPercent: '0',
      },
      false,
    ],
    ['unset percents count as zero', { rakebackPercent: '100' }, false],
    ['rakeback alone just over', { rakebackPercent: '100.01' }, true],
    [
      'exactly 100 across four fields',
      {
        rakebackPercent: '25',
        dailyBonusPercent: '25',
        weeklyBonusPercent: '25',
        monthlyBonusPercent: '25',
      },
      false,
    ],
    [
      'one hundredth over 100',
      {
        rakebackPercent: '25',
        dailyBonusPercent: '25',
        weeklyBonusPercent: '25',
        monthlyBonusPercent: '25.01',
      },
      true,
    ],
    [
      '33.34 + 33.33 + 33.33 equals 100',
      { rakebackPercent: '33.34', dailyBonusPercent: '33.33', weeklyBonusPercent: '33.33' },
      false,
    ],
    [
      '33.34 + 33.33 + 33.34 is over',
      { rakebackPercent: '33.34', dailyBonusPercent: '33.33', weeklyBonusPercent: '33.34' },
      true,
    ],
    ['undefined optional fields', { rakebackPercent: '50' }, false],
    [
      'single-decimal fractions pad to hundredths',
      { rakebackPercent: '50.5', dailyBonusPercent: '49.5' },
      false,
    ],
    ['single-decimal fractions over', { rakebackPercent: '50.5', dailyBonusPercent: '49.6' }, true],
    [
      '0.1 + 0.2 style sums stay exact',
      { rakebackPercent: '0.1', dailyBonusPercent: '0.2', weeklyBonusPercent: '99.7' },
      false,
    ],
    [
      '0.1 + 0.2 style sums over',
      { rakebackPercent: '0.1', dailyBonusPercent: '0.2', weeklyBonusPercent: '99.71' },
      true,
    ],
  ])('%s', (_name, input, expected) => {
    expect(paysOverHouseEdge(input)).toBe(expected);
  });

  const percent = fc
    .tuple(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 2 }),
    )
    .map(([whole, cents, style]) => {
      const fraction = String(cents).padStart(2, '0');
      if (style === 0) {
        return `${whole}.${fraction}`;
      }
      if (style === 1) {
        return `${whole}.${fraction.replace(/0$/, '')}`.replace(/\.$/, '');
      }
      return String(whole);
    })
    .filter((value) => ContributionPercentSchema.safeParse(value).success);

  const exactHundredths = (value: string | null) => {
    if (value === null) {
      return 0n;
    }
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  };

  it('matches an exact bigint sum for every schema-valid percent', () => {
    fc.assert(
      fc.property(
        percent,
        fc.option(percent, { nil: null }),
        fc.option(percent, { nil: null }),
        fc.option(percent, { nil: null }),
        (rakeback, daily, weekly, monthly) => {
          const sum =
            exactHundredths(rakeback) +
            exactHundredths(daily) +
            exactHundredths(weekly) +
            exactHundredths(monthly);
          expect(
            paysOverHouseEdge({
              rakebackPercent: rakeback,
              dailyBonusPercent: daily,
              weeklyBonusPercent: weekly,
              monthlyBonusPercent: monthly,
            }),
          ).toBe(sum > 10_000n);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('is symmetric in the three periodic percents', () => {
    fc.assert(
      fc.property(percent, percent, percent, percent, (rakeback, a, b, c) => {
        expect(
          paysOverHouseEdge({
            rakebackPercent: rakeback,
            dailyBonusPercent: a,
            weeklyBonusPercent: b,
            monthlyBonusPercent: c,
          }),
        ).toBe(
          paysOverHouseEdge({
            rakebackPercent: rakeback,
            dailyBonusPercent: c,
            weeklyBonusPercent: a,
            monthlyBonusPercent: b,
          }),
        );
      }),
    );
  });

  describe('percents with three or more decimals', () => {
    it.each(['1.234', '33.333', '0.001', '99.999'])(
      'the contract rejects %s before paysOverHouseEdge can see it',
      (value) => {
        expect(ContributionPercentSchema.safeParse(value).success).toBe(false);
      },
    );
  });
});

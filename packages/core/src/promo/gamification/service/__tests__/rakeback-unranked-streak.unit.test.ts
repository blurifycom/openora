import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyCompare, moneyEquals } from '@openora/core/server';
import { streakRecord, unrankedRakeback } from '../rakeback.service.js';

const amount = fc
  .tuple(fc.nat(1_000_000), fc.nat(99_999_999))
  .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(8, '0')}`);

const percent = fc
  .tuple(fc.nat(100), fc.nat(99))
  .map(([whole, fraction]) =>
    whole === 100 ? '100' : `${whole}.${String(fraction).padStart(2, '0')}`,
  );

const rtp = fc.nat(10_000).map((basisPoints) => (basisPoints / 10_000).toFixed(4));

describe('unrankedRakeback', () => {
  it.each([
    ['1% of a 4% edge on 100', '100', '0.96', '1', '0.04'],
    ['10% of a 4% edge on 100', '100', '0.96', '10', '0.4'],
    ['full rate pays the whole edge', '100', '0.96', '100', '4'],
    ['zero rate', '100', '0.96', '0', '0'],
    ['rtp of one leaves no edge', '100', '1', '10', '0'],
    ['rtp of one with trailing zeros', '100', '1.000', '10', '0'],
    ['missing rtp', '100', undefined, '10', '0'],
    ['null rtp', '100', null, '10', '0'],
    ['zero rtp counts as missing', '100', '0', '10', '0'],
    ['zero rtp with decimals counts as missing', '100', '0.000', '10', '0'],
    ['rtp given as a percent is refused', '100', '96', '10', '0'],
    ['rtp above one is refused', '100', '1.5', '10', '0'],
    ['negative rtp is refused', '100', '-0.5', '10', '0'],
    ['rtp in exponent form is refused', '100', '9.6e-1', '10', '0'],
    ['rtp with a leading plus is refused', '100', '+0.96', '10', '0'],
    ['rtp with 19 decimals is refused', '100', '0.9600000000000000001', '10', '0'],
    ['zero stake', '0', '0.96', '10', '0'],
    ['dust stake truncates toward zero', '0.000000000000000001', '0.5', '50', '0'],
  ])('%s', (_name, realAmount, gameRtp, ratePercent, expected) => {
    expect(moneyEquals(unrankedRakeback({ realAmount, rtp: gameRtp, ratePercent }), expected)).toBe(
      true,
    );
  });

  it('never pays more than the house edge on the stake', () => {
    fc.assert(
      fc.property(amount, rtp, percent, (realAmount, gameRtp, ratePercent) => {
        const paid = unrankedRakeback({ realAmount, rtp: gameRtp, ratePercent });
        expect(moneyCompare(paid, '0')).toBeGreaterThanOrEqual(0);
        expect(moneyCompare(paid, realAmount)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('pays no more for a higher rtp', () => {
    fc.assert(
      fc.property(amount, rtp, rtp, percent, (realAmount, left, right, ratePercent) => {
        const [low, high] = [left, right].sort((a, b) => moneyCompare(a, b));
        if (low === undefined || high === undefined || moneyCompare(low, '0') === 0) {
          return;
        }
        expect(
          moneyCompare(
            unrankedRakeback({ realAmount, rtp: high, ratePercent }),
            unrankedRakeback({ realAmount, rtp: low, ratePercent }),
          ),
        ).toBeLessThanOrEqual(0);
      }),
    );
  });
});

describe('streakRecord', () => {
  it.each([
    [
      'unranked with a rate',
      { mode: 'unranked', ratePercent: '1.5' },
      { streakMode: 'unranked', streakPercent: '1.5' },
    ],
    [
      'unranked with a zero rate',
      { mode: 'unranked', ratePercent: '0' },
      { streakMode: null, streakPercent: null },
    ],
    [
      'unranked with a zero rate in decimals',
      { mode: 'unranked', ratePercent: '0.00' },
      { streakMode: null, streakPercent: null },
    ],
    [
      'ranked with an uplift',
      { mode: 'ranked', ratePercent: '10', upliftPercent: '25' },
      { streakMode: 'ranked', streakPercent: '25' },
    ],
    [
      'ranked without uplift records no streak even with a rank rate',
      { mode: 'ranked', ratePercent: '10', upliftPercent: '0' },
      { streakMode: null, streakPercent: null },
    ],
    [
      'ranked with a smallest-unit uplift',
      { mode: 'ranked', ratePercent: '10', upliftPercent: '0.000000000000000001' },
      { streakMode: 'ranked', streakPercent: '0.000000000000000001' },
    ],
    [
      'ranked with a negative uplift',
      { mode: 'ranked', ratePercent: '10', upliftPercent: '-5' },
      { streakMode: null, streakPercent: null },
    ],
  ] as const)('%s', (_name, rate, expected) => {
    expect(streakRecord(rate)).toEqual(expected);
  });
});

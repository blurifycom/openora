import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyAdd, moneyCompare, moneyEquals } from '@openora/core/server';
import { marginBonus } from '../rank-payout.service.js';
import { rankedRakeback } from '../rakeback.service.js';

const amount = fc
  .tuple(fc.nat(1_000_000), fc.nat(999_999))
  .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(6, '0')}`);

const percent = fc
  .tuple(fc.nat(100), fc.nat(99))
  .map(([whole, fraction]) =>
    whole === 100 ? '100' : `${whole}.${String(fraction).padStart(2, '0')}`,
  );

describe('rankedRakeback', () => {
  it.each([
    ['no uplift', '100', '10', '0', '10'],
    ['half uplift multiplies the rate', '100', '10', '50', '15'],
    ['double uplift', '100', '10', '100', '20'],
    ['zero base', '0', '10', '50', '0'],
    ['zero rate ignores uplift', '100', '0', '500', '0'],
    ['fractional rate', '200', '0.5', '0', '1'],
    ['full rate no uplift returns the base', '37.5', '100', '0', '37.5'],
  ])('%s', (_name, base, ratePercent, upliftPercent, expected) => {
    expect(moneyEquals(rankedRakeback({ base, ratePercent, upliftPercent }), expected)).toBe(true);
  });

  it('never pays more than the base when the rate is at most 100 and there is no uplift', () => {
    fc.assert(
      fc.property(amount, percent, (base, ratePercent) => {
        expect(
          moneyCompare(rankedRakeback({ base, ratePercent, upliftPercent: '0' }), base),
        ).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('never decreases as the uplift grows', () => {
    fc.assert(
      fc.property(amount, percent, percent, percent, (base, ratePercent, a, b) => {
        const [low, high] = moneyCompare(a, b) <= 0 ? [a, b] : [b, a];
        expect(
          moneyCompare(
            rankedRakeback({ base, ratePercent, upliftPercent: low }),
            rankedRakeback({ base, ratePercent, upliftPercent: high }),
          ),
        ).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('multiplies the rate: uplift 100 pays twice the no-uplift rakeback within truncation', () => {
    fc.assert(
      fc.property(amount, percent, (base, ratePercent) => {
        const plain = rankedRakeback({ base, ratePercent, upliftPercent: '0' });
        const doubled = rankedRakeback({ base, ratePercent, upliftPercent: '100' });
        const twice = moneyAdd(plain, plain);
        expect(moneyCompare(doubled, twice)).toBeGreaterThanOrEqual(0);
        expect(moneyCompare(doubled, moneyAdd(twice, '0.000000000000000002'))).toBeLessThanOrEqual(
          0,
        );
      }),
    );
  });
});

describe('marginBonus', () => {
  it.each([
    ['percent of the margin', '200', '10', null, '20'],
    ['capped when earned exceeds the cap', '200', '10', '5', '5'],
    ['cap equal to earned', '200', '10', '20', '20'],
    ['cap above earned', '200', '10', '50', '20'],
    ['full percent pays the whole margin', '12.34', '100', null, '12.34'],
    ['fractional percent', '1000', '0.25', null, '2.5'],
  ])('%s', (_name, margin, pct, cap, expected) => {
    const result = marginBonus(margin, pct, cap);
    expect(result).not.toBeNull();
    expect(moneyEquals(result ?? '', expected)).toBe(true);
  });

  it.each([
    ['zero margin', '0', '10', null],
    ['zero percent', '100', '0', null],
    ['zero margin with a cap', '0', '10', '5'],
    ['earned below one minor unit', '0.000000000000000001', '1', null],
  ])('is null for %s', (_name, margin, pct, cap) => {
    expect(marginBonus(margin, pct, cap)).toBeNull();
  });

  it('never exceeds the cap', () => {
    fc.assert(
      fc.property(amount, percent, amount, (margin, pct, cap) => {
        const result = marginBonus(margin, pct, cap);
        if (result !== null) {
          expect(moneyCompare(result, cap)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('never pays more than the margin at a percent of 100 or less', () => {
    fc.assert(
      fc.property(amount, percent, (margin, pct) => {
        const result = marginBonus(margin, pct, null);
        if (result !== null) {
          expect(moneyCompare(result, margin)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('two bonuses whose percents total at most 100 never pay over the margin together', () => {
    fc.assert(
      fc.property(
        amount,
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (margin, a, b) => {
          fc.pre(a + b <= 10_000);
          const toPercent = (hundredths: number) => (hundredths / 100).toFixed(2);
          const paid = moneyAdd(
            marginBonus(margin, toPercent(a), null) ?? '0',
            marginBonus(margin, toPercent(b), null) ?? '0',
          );
          expect(moneyCompare(paid, margin)).toBeLessThanOrEqual(0);
        },
      ),
    );
  });
});

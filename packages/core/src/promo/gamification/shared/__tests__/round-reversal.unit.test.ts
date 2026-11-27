import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyCompare, moneyEquals } from '@openora/core/server';
import { roundReversal } from '../round-reversal.js';

const amount = fc
  .tuple(fc.nat(100_000), fc.nat(999_999))
  .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(6, '0')}`);

describe('roundReversal', () => {
  it.each([
    ['equal to the stake', '10', '5', '10'],
    ['above the stake is capped at the stake', '10', '5', '25'],
  ])('reversing %s takes back the whole contribution', (_name, stake, wagered, reversed) => {
    expect(roundReversal({ stake, wagered }, reversed)).toEqual({ stake, wagered });
  });

  it.each([
    ['a quarter', '10', '5', '2.5', '1.25'],
    ['a rate that halved since the bet', '10', '5', '4', '2'],
    ['a rate that doubled since the bet', '10', '20', '4', '8'],
    ['a zero reversal', '10', '5', '0', '0'],
    ['nothing counted', '10', '0', '3', '0'],
  ])('takes back %s in proportion', (_name, stake, wagered, reversed, expectedWagered) => {
    const result = roundReversal({ stake, wagered }, reversed);
    expect(result.stake).toBe(reversed);
    expect(moneyEquals(result.wagered, expectedWagered)).toBe(true);
  });

  it('never takes back more than stands, in stake or in counted amount', () => {
    fc.assert(
      fc.property(amount, amount, amount, (stake, wagered, reversed) => {
        fc.pre(moneyCompare(stake, '0') > 0);
        const result = roundReversal({ stake, wagered }, reversed);
        expect(moneyCompare(result.stake, stake)).toBeLessThanOrEqual(0);
        expect(moneyCompare(result.wagered, wagered)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('takes back a counted amount that grows with the reversed stake', () => {
    fc.assert(
      fc.property(amount, amount, amount, amount, (stake, wagered, a, b) => {
        fc.pre(moneyCompare(stake, '0') > 0);
        const [low, high] = moneyCompare(a, b) <= 0 ? [a, b] : [b, a];
        expect(
          moneyCompare(
            roundReversal({ stake, wagered }, low).wagered,
            roundReversal({ stake, wagered }, high).wagered,
          ),
        ).toBeLessThanOrEqual(0);
      }),
    );
  });
});

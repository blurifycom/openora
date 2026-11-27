import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertPositionsAffordable, RacePositionsInvalidError } from '../race-admin.service.js';
import { moneyAdd, moneyCompare } from '@openora/core/server';
import { amountToNextPaidPosition, maskUsername } from '../race.service.js';

describe('maskUsername', () => {
  it.each([
    ['', '****'],
    ['a', '****'],
    ['ab', 'a****'],
    ['abc', 'ab****'],
    ['abcd', 'abc****'],
    ['averyveryverylongname', 'ave****'],
  ])('%j masks to %j', (name, masked) => {
    expect(maskUsername(name)).toBe(masked);
  });

  it('never shows a whole name', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (name) => {
        const shown = maskUsername(name).slice(0, -4);
        expect(shown.length).toBeLessThan(name.length);
        expect(name.startsWith(shown)).toBe(true);
      }),
    );
  });

  it('shows at most three characters and always the same fixed suffix', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const masked = maskUsername(name);
        expect(masked.endsWith('****')).toBe(true);
        expect(masked.length).toBeLessThanOrEqual(7);
      }),
    );
  });

  it('does not tell names of different lengths apart past the third character', () => {
    expect(maskUsername('player')).toBe(maskUsername('playerwithalongername'));
  });
});

describe('assertPositionsAffordable', () => {
  const prizes = (...values: string[]) => values.map((prize) => ({ prize }));

  it.each([
    ['no positions', '100', prizes()],
    ['prizes equal to the pool', '100', prizes('50', '30', '20')],
    ['prizes below the pool', '100', prizes('50', '30')],
    ['float-unsafe decimals summing exactly to the pool', '0.3', prizes('0.1', '0.2')],
    [
      '18-decimal prizes summing exactly to the pool',
      '1',
      prizes('0.333333333333333333', '0.333333333333333333', '0.333333333333333334'),
    ],
    ['a zero pool with zero prizes', '0', prizes('0', '0')],
    ['trailing zeros on the pool', '100.000', prizes('100')],
  ])('accepts %s', (_name, pool, positions) => {
    expect(() => assertPositionsAffordable(pool, positions)).not.toThrow();
  });

  it.each([
    ['one prize above the pool', '100', prizes('100.01')],
    ['prizes over the pool by one smallest unit', '1', prizes('0.5', '0.500000000000000001')],
    ['a prize on a zero pool', '0', prizes('0.000000000000000001')],
    ['large sums past float precision', '9007199254740993', prizes('9007199254740992', '2')],
    [
      'many small prizes adding up past the pool',
      '1',
      prizes(...Array.from({ length: 11 }, () => '0.1')),
    ],
  ])('refuses %s', (_name, pool, positions) => {
    expect(() => assertPositionsAffordable(pool, positions)).toThrow(RacePositionsInvalidError);
  });

  it('accepts exactly when the prizes sum to at most the pool, in any order', () => {
    const cents = fc.nat(1_000_000);
    fc.assert(
      fc.property(fc.array(cents, { maxLength: 20 }), cents, (prizeCents, poolCents) => {
        const total = prizeCents.reduce((sum, value) => sum + value, 0);
        const toAmount = (value: number) => (value / 100).toFixed(2);
        const positions = prizes(...prizeCents.map(toAmount));
        const call = () => assertPositionsAffordable(toAmount(poolCents), [...positions].reverse());
        if (total <= poolCents) {
          expect(call).not.toThrow();
        } else {
          expect(call).toThrow(RacePositionsInvalidError);
        }
      }),
    );
  });
});

describe('amountToNextPaidPosition', () => {
  const board = (...wagered: string[]) =>
    wagered.map((amount, index) => ({
      userId: `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      username: `racer${index + 1}`,
      wagered: amount,
      position: index + 1,
    }));

  it.each([
    ['a race that pays nobody', 0, board('50', '40', '30'), 2, null],
    ['the first paid place', 2, board('50', '40', '30'), 0, null],
    ['the last paid place', 2, board('50', '40', '30'), 1, null],
    ['a player missing from the board', 2, board('50', '40', '30'), 7, null],
    ['paid places beyond the capped board', 5, board('50', '40', '30'), 2, null],
  ])('is null for %s', (_case, paidPositions, entries, ownIndex, expected) => {
    expect(amountToNextPaidPosition(paidPositions, entries, ownIndex)).toBe(expected);
  });

  it.each([
    ['right below the paid zone', 2, board('50', '40', '30'), 2, '10.000000000000000000'],
    [
      'far below the paid zone, measured to the last paid place',
      1,
      board('50', '40', '30'),
      2,
      '20.000000000000000000',
    ],
    ['with 18-decimal precision', 1, board('1.000000000000000001', '1'), 1, '0.000000000000000001'],
    ['on an exact tie with the last paid place', 1, board('50', '50'), 1, '0'],
  ])('measures the gap %s', (_case, paidPositions, entries, ownIndex, expected) => {
    expect(amountToNextPaidPosition(paidPositions, entries, ownIndex)).toBe(expected);
  });

  it('closes the gap exactly when the player adds the returned amount', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 2, maxLength: 20 }),
        fc.integer({ min: 1, max: 19 }),
        (amounts, paid) => {
          const sorted = [...amounts].sort((a, b) => b - a).map(String);
          const paidPositions = Math.min(paid, sorted.length - 1);
          const ownIndex = sorted.length - 1;
          const gap = amountToNextPaidPosition(paidPositions, board(...sorted), ownIndex);
          const lastPaid = sorted[paidPositions - 1];
          const own = sorted[ownIndex];
          if (gap === null || lastPaid === undefined || own === undefined) {
            throw new Error('expected a gap for a player outside the paid zone');
          }
          expect(moneyCompare(gap, '0')).toBeGreaterThanOrEqual(0);
          expect(moneyCompare(moneyAdd(own, gap), lastPaid)).toBe(0);
        },
      ),
    );
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MONEY_SCALE } from '@openora/core/contracts';
import {
  expandMoneyExponent,
  houseEdge,
  isPositiveMoney,
  moneyAdd,
  moneyCeilToScale,
  moneyCompare,
  moneyDivide,
  moneyEquals,
  moneyFloorToScale,
  moneyMultiplyDivide,
  moneyScaleBy,
  moneySubtract,
} from '../query-helpers.js';

const ONE = 10n ** BigInt(MONEY_SCALE);
const MAX_UNITS = 10n ** 38n - 1n;

function unitsToMoney(units: bigint, keptDecimals: number): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const whole = (abs / ONE).toString();
  const fraction = (abs % ONE).toString().padStart(MONEY_SCALE, '0');
  const trimmed = fraction.replace(/0+$/, '');
  const shown = trimmed.padEnd(Math.max(keptDecimals, trimmed.length), '0');
  return shown === '' ? `${sign}${whole}` : `${sign}${whole}.${shown}`;
}

function moneyToUnits(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = amount.replace('-', '').split('.');
  const units = BigInt(whole) * ONE + BigInt(fraction.padEnd(MONEY_SCALE, '0') || '0');
  return negative ? -units : units;
}

const units = fc.bigInt({ min: 0n, max: MAX_UNITS });
const signedUnits = fc.bigInt({ min: -MAX_UNITS, max: MAX_UNITS });
const nonZeroUnits = fc.bigInt({ min: 1n, max: MAX_UNITS });
const notation = fc.integer({ min: 0, max: MONEY_SCALE });
const money = fc.tuple(units, notation).map(([value, kept]) => unitsToMoney(value, kept));
const signedMoney = fc
  .tuple(signedUnits, notation)
  .map(([value, kept]) => unitsToMoney(value, kept));
const scale = fc.integer({ min: 0, max: MONEY_SCALE });

describe('money arithmetic', () => {
  describe('moneyCompare and moneyEquals', () => {
    it('orders amounts exactly like their minor units', () => {
      fc.assert(
        fc.property(signedMoney, signedMoney, (a, b) => {
          const diff = moneyToUnits(a) - moneyToUnits(b);
          expect(moneyCompare(a, b)).toBe(diff < 0n ? -1 : diff > 0n ? 1 : 0);
        }),
      );
    });

    it('treats the same value in any notation as equal', () => {
      fc.assert(
        fc.property(units, notation, notation, (value, left, right) => {
          expect(moneyEquals(unitsToMoney(value, left), unitsToMoney(value, right))).toBe(true);
        }),
      );
    });

    it.each([
      ['10', '10.00', true],
      ['0.1', '0.10', true],
      ['0.000000000000000001', '0', false],
      ['99999999999999999999.999999999999999999', '99999999999999999999.999999999999999998', false],
    ])('moneyEquals(%s, %s) is %s', (a, b, expected) => {
      expect(moneyEquals(a, b)).toBe(expected);
    });
  });

  describe('moneyAdd and moneySubtract', () => {
    it('adds without float noise', () => {
      expect(moneyEquals(moneyAdd('0.1', '0.2'), '0.3')).toBe(true);
    });

    it('matches exact minor-unit addition and subtraction', () => {
      fc.assert(
        fc.property(signedMoney, signedMoney, (a, b) => {
          expect(moneyToUnits(moneyAdd(a, b))).toBe(moneyToUnits(a) + moneyToUnits(b));
          expect(moneyToUnits(moneySubtract(a, b))).toBe(moneyToUnits(a) - moneyToUnits(b));
        }),
      );
    });

    it('undoes an addition with a subtraction', () => {
      fc.assert(
        fc.property(signedMoney, signedMoney, (a, b) => {
          expect(moneyEquals(moneySubtract(moneyAdd(a, b), b), a)).toBe(true);
        }),
      );
    });

    it('is commutative and associative', () => {
      fc.assert(
        fc.property(signedMoney, signedMoney, signedMoney, (a, b, c) => {
          expect(moneyEquals(moneyAdd(a, b), moneyAdd(b, a))).toBe(true);
          expect(moneyEquals(moneyAdd(moneyAdd(a, b), c), moneyAdd(a, moneyAdd(b, c)))).toBe(true);
        }),
      );
    });
  });

  describe('moneyFloorToScale and moneyCeilToScale', () => {
    it('brackets any amount within one step of the scale', () => {
      fc.assert(
        fc.property(signedMoney, scale, (amount, places) => {
          const floor = moneyFloorToScale(amount, places);
          const ceil = moneyCeilToScale(amount, places);
          const step = 10n ** BigInt(MONEY_SCALE - places);
          expect(moneyCompare(floor, amount)).toBeLessThanOrEqual(0);
          expect(moneyCompare(ceil, amount)).toBeGreaterThanOrEqual(0);
          expect([0n, step]).toContain(moneyToUnits(ceil) - moneyToUnits(floor));
          expect(moneyToUnits(floor) % step).toBe(0n);
        }),
      );
    });

    it('leaves an amount already at the scale unchanged', () => {
      fc.assert(
        fc.property(units, scale, (value, places) => {
          const step = 10n ** BigInt(MONEY_SCALE - places);
          const atScale = unitsToMoney(value - (value % step), 0);
          expect(moneyEquals(moneyFloorToScale(atScale, places), atScale)).toBe(true);
          expect(moneyEquals(moneyCeilToScale(atScale, places), atScale)).toBe(true);
        }),
      );
    });

    it.each([
      ['1.239', 2, '1.23', '1.24'],
      ['1.2', 2, '1.20', '1.20'],
      ['0.000000000000000001', 0, '0', '1'],
      ['0.5', 0, '0', '1'],
      ['7', 6, '7.000000', '7.000000'],
      ['-1.5', 0, '-2', '-1'],
      ['-0.05', 1, '-0.1', '0.0'],
      ['-0.5', 1, '-0.5', '-0.5'],
      ['-0.000000000000000001', 0, '-1', '0'],
    ])('%s at scale %i floors to %s and ceils to %s', (amount, places, floor, ceil) => {
      expect(moneyFloorToScale(amount, places)).toBe(floor);
      expect(moneyCeilToScale(amount, places)).toBe(ceil);
    });
  });

  describe('moneyScaleBy, moneyMultiplyDivide and moneyDivide', () => {
    it('truncates a product towards zero, never rounding up', () => {
      fc.assert(
        fc.property(money, money, (amount, factor) => {
          const exact = moneyToUnits(amount) * moneyToUnits(factor);
          const result = moneyToUnits(moneyScaleBy(amount, factor)) * ONE;
          expect(result <= exact).toBe(true);
          expect(exact - result < ONE).toBe(true);
        }),
      );
    });

    it('multiplies before dividing so nothing is lost in between', () => {
      expect(moneyMultiplyDivide('1', '1', '3')).toBe('0.333333333333333333');
      expect(moneyEquals(moneyMultiplyDivide('10', '3', '3'), '10')).toBe(true);
      expect(moneyEquals(moneyDivide('10', '3'), '3.333333333333333333')).toBe(true);
    });

    it('matches exact truncated division', () => {
      fc.assert(
        fc.property(money, nonZeroUnits, (dividend, divisorUnits) => {
          const divisor = unitsToMoney(divisorUnits, 0);
          expect(moneyToUnits(moneyDivide(dividend, divisor))).toBe(
            (moneyToUnits(dividend) * ONE) / divisorUnits,
          );
        }),
      );
    });

    it('refuses to divide by zero in any notation', () => {
      for (const zero of ['0', '0.0', '0.000000000000000000']) {
        expect(() => moneyDivide('1', zero)).toThrow(RangeError);
        expect(() => moneyMultiplyDivide('1', '1', zero)).toThrow(RangeError);
      }
    });
  });

  describe('isPositiveMoney', () => {
    it.each([
      ['0.000000000000000001', true],
      ['1', true],
      ['0', false],
      ['0.000', false],
      ['-1', false],
      ['-0', false],
      ['NaN', false],
      ['', false],
      ['1e3', false],
      ['Infinity', false],
      [' 1', false],
      ['1.0000000000000000001', false],
    ])('%j is %s', (value, expected) => {
      expect(isPositiveMoney(value)).toBe(expected);
    });

    it('accepts every positive amount the money format allows', () => {
      fc.assert(
        fc.property(nonZeroUnits, notation, (value, kept) => {
          expect(isPositiveMoney(unitsToMoney(value, kept))).toBe(true);
        }),
      );
    });
  });

  describe('expandMoneyExponent', () => {
    it.each([
      ['1e-7', '0.0000001'],
      ['1E5', '100000'],
      ['1.5e2', '150'],
      ['1.25e1', '12.5'],
      ['2.5e-1', '0.25'],
      ['1e+3', '1000'],
      ['12.5', '12.5'],
      ['-1e-2', '-1e-2'],
      ['abc', 'abc'],
    ])('%s becomes %s', (value, expected) => {
      expect(expandMoneyExponent(value)).toBe(expected);
    });

    it('expands digits shifted by an exponent back to the same value', () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 1n, max: 10n ** 20n }),
          fc.integer({ min: 0, max: MONEY_SCALE }),
          (digits, shift) => {
            const expanded = expandMoneyExponent(`${digits}e-${shift}`);
            expect(moneyToUnits(expanded)).toBe(digits * 10n ** BigInt(MONEY_SCALE - shift));
          },
        ),
      );
    });
  });

  describe('houseEdge', () => {
    it.each([
      ['100', '0.97', '3'],
      ['100', '1', '0'],
      ['100', null, '0'],
      ['100', undefined, '0'],
      ['100', '0', '0'],
      ['0', '0.97', '0'],
    ])('stake %s at rtp %s keeps %s', (stake, rtp, expected) => {
      expect(moneyEquals(houseEdge(stake, rtp), expected)).toBe(true);
    });
  });
});

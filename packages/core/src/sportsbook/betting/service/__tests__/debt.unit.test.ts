import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyAdd, moneyCompare, moneyEquals } from '@openora/core/server';
import { unconsumed } from '../debt.service.js';

const money = (cents: number) =>
  `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const sum = (amounts: string[]) => amounts.reduce(moneyAdd, '0');

describe('unconsumed', () => {
  it.each([
    [
      'nothing consumed',
      [
        ['a', '5'],
        ['b', '3'],
      ],
      '0',
      [
        ['a', '5'],
        ['b', '3'],
      ],
    ],
    [
      'the oldest part-consumed',
      [
        ['a', '5'],
        ['b', '3'],
      ],
      '2',
      [
        ['a', '3'],
        ['b', '3'],
      ],
    ],
    [
      'the oldest exactly consumed',
      [
        ['a', '5'],
        ['b', '3'],
      ],
      '5',
      [['b', '3']],
    ],
    [
      'spilling into the next',
      [
        ['a', '5'],
        ['b', '3'],
      ],
      '6',
      [['b', '2']],
    ],
    [
      'everything exactly consumed',
      [
        ['a', '5'],
        ['b', '3'],
      ],
      '8',
      [],
    ],
    [
      'more consumed than owed',
      [
        ['a', '5'],
        ['b', '3'],
      ],
      '100',
      [],
    ],
    ['no shortfalls', [], '4', []],
  ])('%s', (_name, shortfalls, consumed, expected) => {
    const rows = shortfalls.map(([name, amount]) => ({ name, amount }));
    const result = unconsumed(rows, consumed).map((row) => [row.name, row.remaining]);
    expect(result.length).toBe(expected.length);
    result.forEach(([name, remaining], i) => {
      expect(name).toBe(expected[i]?.[0]);
      expect(moneyEquals(remaining ?? '', expected[i]?.[1] ?? '')).toBe(true);
    });
  });

  it('keeps the other fields and the order of each surviving shortfall', () => {
    const rows = [
      { id: 'a', amount: '5', createdAt: 1 },
      { id: 'b', amount: '3', createdAt: 2 },
    ];
    const [only, ...others] = unconsumed(rows, '5');
    expect(others).toEqual([]);
    expect(only).toMatchObject({ id: 'b', amount: '3', createdAt: 2 });
    expect(moneyEquals(only?.remaining ?? '', '3')).toBe(true);
  });

  it('leaves the sum of remainders at the sum of shortfalls minus consumed, floored at zero', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 100_000 }),
        (amounts, consumed) => {
          const rows = amounts.map((cents) => ({ amount: money(cents) }));
          const remaining = sum(unconsumed(rows, money(consumed)).map((row) => row.remaining));
          const owed = amounts.reduce((total, cents) => total + cents, 0);
          expect(moneyEquals(remaining, money(Math.max(0, owed - consumed)))).toBe(true);
        },
      ),
    );
  });

  it('never leaves a remainder above its shortfall or at zero', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 100_000 }),
        (amounts, consumed) => {
          const rows = amounts.map((cents) => ({ amount: money(cents) }));
          for (const row of unconsumed(rows, money(consumed))) {
            expect(moneyCompare(row.remaining, row.amount)).toBeLessThanOrEqual(0);
            expect(moneyCompare(row.remaining, '0')).toBeGreaterThan(0);
          }
        },
      ),
    );
  });

  it('consumes the oldest first: only the first survivor may be part-consumed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 100_000 }),
        (amounts, consumed) => {
          const rows = amounts.map((cents) => ({ amount: money(cents) }));
          const rest = unconsumed(rows, money(consumed));
          for (const row of rest.slice(1)) {
            expect(moneyEquals(row.remaining, row.amount)).toBe(true);
          }
          const dropped = rows.length - rest.length;
          const droppedSum = sum(rows.slice(0, dropped).map((row) => row.amount));
          expect(moneyCompare(droppedSum, money(consumed))).toBeLessThanOrEqual(0);
        },
      ),
    );
  });
});

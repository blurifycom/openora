import { describe, expect, it } from 'vitest';
import {
  findOneOrThrow,
  pageToOffset,
  isUniqueConstraintViolation,
  uniqueConstraintName,
  escapeLike,
  likeContains,
  likePrefix,
  moneyToNumber,
  moneyEquals,
  moneyCompare,
  moneyScaleBy,
  moneyDivide,
  moneyAdd,
  moneySubtract,
  moneyFloorToScale,
  moneyCeilToScale,
  mapConcurrent,
} from '../query-helpers.js';

describe('findOneOrThrow', () => {
  it('returns the first row when present', () => {
    expect(findOneOrThrow([{ id: '1' }, { id: '2' }], new Error('nope'))).toEqual({ id: '1' });
  });

  it('throws the provided error on an empty array', () => {
    const err = new Error('not found');
    expect(() => findOneOrThrow([], err)).toThrow(err);
  });
});

describe('pageToOffset', () => {
  it('converts a 1-based page + limit to an offset', () => {
    expect(pageToOffset(1, 20)).toBe(0);
    expect(pageToOffset(3, 20)).toBe(40);
  });
});

describe('isUniqueConstraintViolation', () => {
  it('matches a Postgres unique violation by code', () => {
    expect(isUniqueConstraintViolation({ code: '23505' })).toBe(true);
  });

  it('rejects other pg codes and non-errors', () => {
    expect(isUniqueConstraintViolation({ code: '23503' })).toBe(false);
    expect(isUniqueConstraintViolation({})).toBe(false);
    expect(isUniqueConstraintViolation(null)).toBe(false);
    expect(isUniqueConstraintViolation('23505')).toBe(false);
  });
});

describe('uniqueConstraintName', () => {
  it('reads the violated index off a 23505', () => {
    expect(uniqueConstraintName({ code: '23505', constraint: 'game_provider_slug_key' })).toBe(
      'game_provider_slug_key',
    );
  });

  it('returns null when no constraint travelled with the error', () => {
    expect(uniqueConstraintName({ code: '23505' })).toBeNull();
    expect(uniqueConstraintName({ code: '23505', constraint: 42 })).toBeNull();
    expect(uniqueConstraintName(null)).toBeNull();
    expect(uniqueConstraintName('game_provider_slug_key')).toBeNull();
  });
});

describe('escapeLike', () => {
  it('escapes % _ and backslash so caller input matches literally', () => {
    expect(escapeLike('100%_\\')).toBe('100\\%\\_\\\\');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeLike('pragmatic')).toBe('pragmatic');
  });
});

describe('likeContains', () => {
  it('wraps escaped input in % for a contains match', () => {
    expect(likeContains('a%b')).toBe('%a\\%b%');
  });
});

describe('likePrefix', () => {
  it('appends % for a prefix match with escaped input', () => {
    expect(likePrefix('rg.')).toBe('rg.%');
    expect(likePrefix('a_b')).toBe('a\\_b%');
  });
});

describe('moneyToNumber', () => {
  it('reads a decimal money string', () => {
    expect(moneyToNumber('100.50')).toBe(100.5);
  });

  it('reads a whole amount', () => {
    expect(moneyToNumber('100')).toBe(100);
  });

  it('reads a zero amount', () => {
    expect(moneyToNumber('0')).toBe(0);
    expect(moneyToNumber('0.00')).toBe(0);
  });

  it('reads a negative amount', () => {
    expect(moneyToNumber('-25.75')).toBe(-25.75);
  });

  it('keeps the ordering of two amounts that differ lexicographically', () => {
    expect(moneyToNumber('9.00')).toBeLessThan(moneyToNumber('10.00'));
  });

  it('returns NaN for a non-numeric string rather than silently zeroing it', () => {
    expect(moneyToNumber('abc')).toBeNaN();
  });
});

describe('moneyEquals', () => {
  it('treats the same amount written at different scales as equal', () => {
    expect(moneyEquals('10', '10.00')).toBe(true);
    expect(moneyEquals('0', '0.000000000000000000')).toBe(true);
    expect(moneyEquals('010.5', '10.5')).toBe(true);
  });

  it('separates two amounts that differ by one wei, where a float compare cannot', () => {
    expect(moneyEquals('1.000000000000000001', '1.000000000000000002')).toBe(false);
    expect(moneyToNumber('1.000000000000000001')).toBe(moneyToNumber('1.000000000000000002'));
  });
});

describe('moneyCompare', () => {
  it('orders two amounts written at different scales', () => {
    expect(moneyCompare('9.00', '10.00')).toBe(-1);
    expect(moneyCompare('10.00', '9.00')).toBe(1);
    expect(moneyCompare('10', '10.00')).toBe(0);
  });

  it('separates two amounts that differ by one wei, where moneyToNumber cannot', () => {
    expect(moneyCompare('1.000000000000000001', '1.000000000000000002')).toBe(-1);
    expect(moneyCompare('1.000000000000000002', '1.000000000000000001')).toBe(1);
    expect(moneyToNumber('1.000000000000000001')).toBe(moneyToNumber('1.000000000000000002'));
  });

  it('orders correctly at the margin where a float compare gives the wrong answer', () => {
    const a = '123456789012345678.000000000000000001';
    const b = '123456789012345678.000000000000000002';
    expect(moneyCompare(a, b)).toBe(-1);
    expect(moneyToNumber(a)).toBe(moneyToNumber(b));
  });
});

describe('moneyScaleBy', () => {
  it('multiplies exactly', () => {
    expect(moneyScaleBy('10', '5')).toBe('50.000000000000000000');
    expect(moneyScaleBy('0.1', '3')).toBe('0.300000000000000000');
  });

  it('scales a whole amount by a fee multiple', () => {
    expect(moneyScaleBy('2.50', '5')).toBe('12.500000000000000000');
  });

  it('is exact where a float multiplication would drift', () => {
    expect(0.1 * 3).not.toBe(0.3);
    expect(moneyScaleBy('0.1', '3')).toBe('0.300000000000000000');
  });

  it('truncates past MONEY_SCALE rather than rounding up', () => {
    expect(moneyScaleBy('1.000000000000000001', '0.5')).toBe('0.500000000000000000');
  });
});

describe('moneyAdd / moneySubtract', () => {
  it('adds and subtracts exactly, at MONEY_SCALE', () => {
    expect(moneyAdd('10', '2.5')).toBe('12.500000000000000000');
    expect(moneySubtract('10', '2.5')).toBe('7.500000000000000000');
  });

  it('is exact where float arithmetic drifts', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(moneyAdd('0.1', '0.2')).toBe('0.300000000000000000');
    expect(moneySubtract('0.3', '0.1')).toBe('0.200000000000000000');
  });

  it('keeps the last unit at MONEY_SCALE rather than losing it', () => {
    expect(moneyAdd('0.000000000000000001', '0.000000000000000002')).toBe('0.000000000000000003');
  });

  it('goes negative rather than clamping - an overdrawn balance must be visible', () => {
    expect(moneySubtract('1', '2.25')).toBe('-1.250000000000000000');
  });

  it('round-trips: subtracting what was added returns the original', () => {
    expect(moneySubtract(moneyAdd('19.99', '0.01'), '0.01')).toBe('19.990000000000000000');
  });
});

describe('moneyDivide', () => {
  it('divides exactly', () => {
    expect(moneyDivide('10', '4')).toBe('2.500000000000000000');
    expect(moneyDivide('1', '3')).toBe('0.333333333333333333');
  });

  it('is exact where a float division would drift', () => {
    expect(0.3 / 0.1).not.toBe(3);
    expect(moneyDivide('0.3', '0.1')).toBe('3.000000000000000000');
  });

  it('is the exact inverse of moneyScaleBy for a whole-dividing pair', () => {
    expect(moneyDivide(moneyScaleBy('7', '3'), '3')).toBe('7.000000000000000000');
  });

  it('derives a cross rate as from/pivot ÷ to/pivot', () => {
    expect(moneyDivide('60000', '1.1')).toBe('54545.454545454545454545');
  });

  it('throws on division by zero rather than returning Infinity/NaN', () => {
    expect(() => moneyDivide('10', '0')).toThrow(RangeError);
  });

  it('truncates past MONEY_SCALE rather than rounding up', () => {
    expect(moneyDivide('1', '3')).toBe('0.333333333333333333');
  });
});

describe('mapConcurrent', () => {
  const identity = async (n: number) => n * 2;

  it('returns results in input order, not completion order', async () => {
    const delays = [30, 5, 20, 1];
    const result = await mapConcurrent(delays, 2, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index;
    });

    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('passes the index alongside each item', async () => {
    const seen: Array<[string, number]> = [];
    await mapConcurrent(['a', 'b', 'c'], 2, async (item, index) => {
      seen.push([item, index]);
    });

    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('never runs more than `concurrency` calls at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    );

    expect(peak).toBe(3);
  });

  it('handles an empty list without spawning a worker', async () => {
    expect(await mapConcurrent([], 5, identity)).toEqual([]);
  });

  it('caps the worker count at the item count', async () => {
    expect(await mapConcurrent([1, 2], 100, identity)).toEqual([2, 4]);
  });

  it('runs serially when concurrency is below 1', async () => {
    expect(await mapConcurrent([1, 2, 3], 0, identity)).toEqual([2, 4, 6]);
  });

  it('rejects when any item rejects', async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async (n) => {
        if (n === 2) {
          throw new Error('item 2 failed');
        }
        return n;
      }),
    ).rejects.toThrow('item 2 failed');
  });
});

describe('moneyFloorToScale', () => {
  it('truncates discarded digits rather than rounding them', () => {
    expect(moneyFloorToScale('66.664999999999999999', 2)).toBe('66.66');
    expect(moneyFloorToScale('19.999999999999999999', 2)).toBe('19.99');
  });

  it('leaves an amount already at the target scale unchanged', () => {
    expect(moneyFloorToScale('20.00', 2)).toBe('20.00');
  });

  it('pads a whole amount out to the target scale', () => {
    expect(moneyFloorToScale('20', 2)).toBe('20.00');
  });

  it('floors a zero amount to zero at scale', () => {
    expect(moneyFloorToScale('0', 2)).toBe('0.00');
  });
});

describe('moneyCeilToScale', () => {
  it('rounds up whenever any discarded digit is nonzero', () => {
    expect(moneyCeilToScale('33.335000000000000001', 2)).toBe('33.34');
    expect(moneyCeilToScale('19.991', 2)).toBe('20.00');
  });

  it('leaves an exact amount unchanged', () => {
    expect(moneyCeilToScale('33.340000000000000000', 2)).toBe('33.34');
  });

  it('leaves a zero amount at zero, never rounding up from nothing', () => {
    expect(moneyCeilToScale('0', 2)).toBe('0.00');
  });
});

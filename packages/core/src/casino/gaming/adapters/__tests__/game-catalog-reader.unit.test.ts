import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  distinctUuids,
  inIdOrder,
  isUuid,
  isValidPage,
  mapInIdOrder,
} from '../game-catalog-reader.service.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('isUuid', () => {
  it.each([
    [A, true],
    ['ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF', true],
    ['', false],
    ['not-a-uuid', false],
    [` ${A}`, false],
    [`${A} `, false],
    [A.slice(1), false],
    [`${A}0`, false],
    ["'; drop table game; --", false],
    ['00000000-0000-0000-0000-000000000000', true],
    ['11111111-1111-1111-1111-11111111111g', false],
  ])('%j is %s', (id, expected) => {
    expect(isUuid(id)).toBe(expected);
  });
});

describe('isValidPage', () => {
  it.each([
    [1, 1, true],
    [1, 50, true],
    [200, 1, true],
    [0, 10, false],
    [-1, 10, false],
    [1, 0, false],
    [1, -5, false],
    [0, 0, false],
    [Number.NaN, 10, false],
    [1, Number.NaN, false],
  ])('page %s limit %s is %s', (page, limit, expected) => {
    expect(isValidPage(page, limit)).toBe(expected);
  });

  it('never allows a negative offset', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (page, limit) => {
        if (isValidPage(page, limit)) {
          expect((page - 1) * limit).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });
});

describe('distinctUuids', () => {
  it('drops malformed ids and duplicates, keeping first-seen order', () => {
    expect(distinctUuids([B, 'junk', A, B, '', A])).toEqual([B, A]);
  });

  it('returns nothing for no ids', () => {
    expect(distinctUuids([])).toEqual([]);
  });

  it('returns only valid uuids with no duplicates for any input', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.uuid(), fc.string())), (ids) => {
        const result = distinctUuids(ids);
        expect(new Set(result).size).toBe(result.length);
        expect(result.every(isUuid)).toBe(true);
      }),
    );
  });
});

describe('inIdOrder', () => {
  it('follows the requested id order, not the lookup order', () => {
    const lookup = new Map([
      [A, 'a'],
      [B, 'b'],
      [C, 'c'],
    ]);
    expect([...inIdOrder([C, A, B], lookup).keys()]).toEqual([C, A, B]);
  });

  it('leaves out ids with no value', () => {
    expect([...inIdOrder([A, B], new Map([[B, 'b']])).keys()]).toEqual([B]);
  });

  it('keeps a falsy value that is not undefined', () => {
    const result = inIdOrder(
      [A, B, C],
      new Map<string, number | string | boolean>([
        [A, 0],
        [B, ''],
        [C, false],
      ]),
    );
    expect([...result.values()]).toEqual([0, '', false]);
  });

  it('drops an explicitly undefined value like a missing one', () => {
    expect(inIdOrder([A], new Map([[A, undefined]])).size).toBe(0);
  });

  it('returns an empty map for no ids', () => {
    expect(inIdOrder([], new Map([[A, 'a']])).size).toBe(0);
  });

  it('collapses a repeated requested id into one entry', () => {
    expect([...inIdOrder([A, A], new Map([[A, 'a']])).entries()]).toEqual([[A, 'a']]);
  });
});

describe('mapInIdOrder', () => {
  it('re-orders database rows into the requested id order', () => {
    const rows = [
      { id: B, name: 'b' },
      { id: A, name: 'a' },
    ];
    expect([...mapInIdOrder([A, B], rows).values()].map((row) => row.name)).toEqual(['a', 'b']);
  });

  it('omits requested ids that have no row, such as an unplayable game', () => {
    expect([...mapInIdOrder([A, C], [{ id: A }]).keys()]).toEqual([A]);
  });

  it('ignores rows that were not requested', () => {
    expect(mapInIdOrder([A], [{ id: A }, { id: B }]).size).toBe(1);
  });

  it('does not match a row id that differs from the request only by case', () => {
    const lower = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
    expect(mapInIdOrder([lower.toUpperCase()], [{ id: lower }]).size).toBe(0);
  });

  it('returns exactly the requested ids that have rows, in request order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.uuid()), fc.uniqueArray(fc.uuid()), (requested, available) => {
        const result = mapInIdOrder(
          requested,
          available.map((id) => ({ id })),
        );
        expect([...result.keys()]).toEqual(requested.filter((id) => available.includes(id)));
      }),
    );
  });
});

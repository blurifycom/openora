import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { uuidPrefixRange } from '../admin-reporting.js';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

describe('uuidPrefixRange', () => {
  it.each([
    ['empty', ''],
    ['only dashes', '----'],
    ['non-hex letter', 'abcg'],
    ['space', 'ab cd'],
    ['sql wildcard', 'ab%'],
    ['quote', "ab'"],
    ['33 hex digits', '0'.repeat(33)],
    ['full uuid plus one digit', `${MAX_UUID}0`],
    ['fullwidth digit', '１'],
    ['arabic-indic digit', '١'],
  ])('rejects %s', (_name, search) => {
    expect(uuidPrefixRange(search)).toBeNull();
  });

  it.each([
    [
      'one digit',
      'a',
      'a0000000-0000-0000-0000-000000000000',
      'afffffff-ffff-ffff-ffff-ffffffffffff',
    ],
    [
      'upper case folds to lower',
      'AB',
      'ab000000-0000-0000-0000-000000000000',
      'abffffff-ffff-ffff-ffff-ffffffffffff',
    ],
    [
      'dashed prefix',
      '0123abcd-ef',
      '0123abcd-ef00-0000-0000-000000000000',
      '0123abcd-efff-ffff-ffff-ffffffffffff',
    ],
    ['exactly 32 digits', 'f'.repeat(32), MAX_UUID, MAX_UUID],
    ['full dashed uuid', ZERO_UUID, ZERO_UUID, ZERO_UUID],
  ])('%s', (_name, search, from, to) => {
    expect(uuidPrefixRange(search)).toEqual({ from, to });
  });

  it('covers every uuid that starts with the prefix, and no uuid that does not', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.integer({ min: 1, max: 36 }), (uuid, cut) => {
        const prefix = uuid.slice(0, cut);
        const range = uuidPrefixRange(prefix);
        expect(range).not.toBeNull();
        if (range === null) {
          return;
        }
        expect(range.from <= uuid && uuid <= range.to).toBe(true);
        expect(range.from.replaceAll('-', '').startsWith(prefix.replaceAll('-', ''))).toBe(true);
        expect(range.to.replaceAll('-', '').startsWith(prefix.replaceAll('-', ''))).toBe(true);
      }),
    );
  });

  it('matches the same range in upper and lower case', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.integer({ min: 1, max: 36 }), (uuid, cut) => {
        const prefix = uuid.slice(0, cut);
        expect(uuidPrefixRange(prefix.toUpperCase())).toEqual(uuidPrefixRange(prefix));
      }),
    );
  });

  it('always returns well-formed uuids with from not above to', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-fA-F]{1,32}$/), (prefix) => {
        const range = uuidPrefixRange(prefix);
        expect(range).not.toBeNull();
        if (range === null) {
          return;
        }
        const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        expect(range.from).toMatch(shape);
        expect(range.to).toMatch(shape);
        expect(range.from <= range.to).toBe(true);
      }),
    );
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  byGameAndCountry,
  chunk,
  gameCountryKey,
  mirrorTargetOf,
  missingCountryCodes,
  pairGeoRuleChanges,
} from '../compliance.service.js';

describe('mirrorTargetOf', () => {
  it.each([
    [true, 'https://mirror.example.test', 'https://mirror.example.test'],
    [false, 'https://mirror.example.test', null],
    [true, null, null],
    [true, '', null],
    [false, null, null],
    [false, '', null],
  ] as const)('redirectIp %s with mirror %j gives %j', (redirectIp, mirrorUrl, expected) => {
    expect(mirrorTargetOf({ redirectIp, mirrorUrl })).toBe(expected);
  });

  it('treats a whitespace-only mirror as a target', () => {
    expect(mirrorTargetOf({ redirectIp: true, mirrorUrl: ' ' })).toBe(' ');
  });
});

describe('missingCountryCodes', () => {
  it.each([
    [['DE', 'FR'], ['DE'], ['FR']],
    [['DE', 'FR'], [], ['DE', 'FR']],
    [[], ['DE'], []],
    [['DE'], ['DE'], []],
    [['DE', 'DE'], [], ['DE', 'DE']],
    [['de'], ['DE'], ['de']],
  ])('requested %j against found %j is missing %j', (requested, found, expected) => {
    expect(
      missingCountryCodes(
        requested,
        found.map((countryCode) => ({ countryCode })),
      ),
    ).toEqual(expected);
  });

  it('keeps requested order', () => {
    expect(missingCountryCodes(['ZW', 'AT', 'MX'], [{ countryCode: 'AT' }])).toEqual(['ZW', 'MX']);
  });
});

describe('pairGeoRuleChanges', () => {
  const at = new Date('2026-03-01T10:00:00.000Z');
  const later = new Date('2026-03-02T10:00:00.000Z');
  const rule = (countryCode: string, over: { reason?: string; updatedAt?: Date } = {}) => ({
    countryCode,
    reason: 'default',
    createdAt: at,
    updatedAt: at,
    ...over,
  });

  it('pairs each after row with the before row of the same country and sorts by country', () => {
    const pairs = pairGeoRuleChanges(
      [rule('DE', { reason: 'old' }), rule('AT')],
      [rule('FR'), rule('DE', { reason: 'new', updatedAt: later }), rule('AT')],
    );
    expect(pairs.map((pair) => pair.after.countryCode)).toEqual(['AT', 'DE', 'FR']);
    expect(pairs[1]?.before?.reason).toBe('old');
    expect(pairs[1]?.after.reason).toBe('new');
  });

  it('gives a null before for a country that had no rule', () => {
    const [pair] = pairGeoRuleChanges([], [rule('FR')]);
    expect(pair?.before).toBeNull();
  });

  it('drops a before row whose country is not in after', () => {
    expect(pairGeoRuleChanges([rule('DE')], [])).toEqual([]);
  });

  it('serializes dates to ISO strings on both sides', () => {
    const [pair] = pairGeoRuleChanges([rule('DE')], [rule('DE', { updatedAt: later })]);
    expect(pair?.before?.createdAt).toBe('2026-03-01T10:00:00.000Z');
    expect(pair?.after.updatedAt).toBe('2026-03-02T10:00:00.000Z');
  });

  it('does not mutate its inputs', () => {
    const before = [rule('DE')];
    const after = [rule('FR'), rule('AT')];
    pairGeoRuleChanges(before, after);
    expect(after.map((row) => row.countryCode)).toEqual(['FR', 'AT']);
    expect(before[0]?.createdAt).toBe(at);
  });
});

describe('chunk', () => {
  it.each([
    [[1, 2, 3, 4, 5], 2, [[1, 2], [3, 4], [5]]],
    [
      [1, 2, 3, 4],
      2,
      [
        [1, 2],
        [3, 4],
      ],
    ],
    [[1, 2], 5, [[1, 2]]],
    [[], 3, []],
    [[1, 2, 3], 1, [[1], [2], [3]]],
  ])('splits %j by %i', (items, size, expected) => {
    expect(chunk(items, size)).toEqual(expected);
  });

  it.each([0, -1, -500, Number.NaN])('refuses size %s instead of dropping items', (size) => {
    expect(() => chunk([1, 2, 3], size)).toThrow();
  });

  it('concatenating the chunks gives the input back, each at most size long', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer({ min: 1, max: 50 }), (items, size) => {
        const chunks = chunk(items, size);
        expect(chunks.flat()).toEqual(items);
        expect(chunks.every((part) => part.length >= 1 && part.length <= size)).toBe(true);
      }),
    );
  });
});

describe('gameCountryKey and byGameAndCountry', () => {
  it('joins game and country with a colon', () => {
    expect(gameCountryKey({ gameId: 'g1', countryCode: 'DE' })).toBe('g1:DE');
  });

  it('keeps distinct pairs distinct', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.constantFrom('DE', 'FR', 'AT', 'PL'),
        fc.constantFrom('DE', 'FR', 'AT', 'PL'),
        (gameA, gameB, countryA, countryB) => {
          const same = gameA === gameB && countryA === countryB;
          const keyA = gameCountryKey({ gameId: gameA, countryCode: countryA });
          const keyB = gameCountryKey({ gameId: gameB, countryCode: countryB });
          expect(keyA === keyB).toBe(same);
        },
      ),
    );
  });

  it('orders by game first, then by country', () => {
    const rows = [
      { gameId: 'b', countryCode: 'AT' },
      { gameId: 'a', countryCode: 'FR' },
      { gameId: 'a', countryCode: 'DE' },
    ];
    expect([...rows].sort(byGameAndCountry)).toEqual([
      { gameId: 'a', countryCode: 'DE' },
      { gameId: 'a', countryCode: 'FR' },
      { gameId: 'b', countryCode: 'AT' },
    ]);
  });

  it('gives the same order whatever the input order', () => {
    const rowArb = fc.record({
      gameId: fc.constantFrom('a', 'b', 'c'),
      countryCode: fc.constantFrom('DE', 'FR', 'AT'),
    });
    fc.assert(
      fc.property(fc.array(rowArb), (rows) => {
        const forward = [...rows].sort(byGameAndCountry);
        const backward = [...rows].reverse().sort(byGameAndCountry);
        expect(backward).toEqual(forward);
      }),
    );
  });
});

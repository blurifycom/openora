import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  categoryRankTriggerIds,
  groupRows,
  isGamePlayable,
  isUnreviewed,
  type GameCategoryTriggerSnapshot,
} from '../game-catalog.js';

const snapshot = (over: Partial<GameCategoryTriggerSnapshot>): GameCategoryTriggerSnapshot => ({
  name: 'Atlas Slots',
  isActive: true,
  providerId: 'provider-1',
  categoryIds: ['cat-a', 'cat-b'],
  ...over,
});

describe('isUnreviewed', () => {
  it.each([
    ['pending', true],
    ['declined', true],
    ['approved', false],
  ] as const)('review status %s is %s', (status, expected) => {
    expect(isUnreviewed(status)).toBe(expected);
  });
});

describe('isGamePlayable', () => {
  it.each([
    [true, false, true, true],
    [false, false, true, false],
    [true, true, true, false],
    [true, false, false, false],
    [false, true, false, false],
    [false, false, false, false],
    [true, true, false, false],
    [false, true, true, false],
  ])(
    'game active %s, unavailable %s, provider active %s is playable %s',
    (isActive, isUnavailable, providerActive, expected) => {
      expect(isGamePlayable({ isActive, isUnavailable }, { isActive: providerActive })).toBe(
        expected,
      );
    },
  );

  it('is playable only for the single combination of active game, available game, active provider', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (isActive, isUnavailable, provider) => {
        expect(isGamePlayable({ isActive, isUnavailable }, { isActive: provider })).toBe(
          isActive && !isUnavailable && provider,
        );
      }),
    );
  });
});

describe('categoryRankTriggerIds', () => {
  it('returns nothing when nothing rank-relevant changed', () => {
    expect(categoryRankTriggerIds(snapshot({}), snapshot({}))).toEqual([]);
  });

  it('ignores a reordering of the same category ids', () => {
    expect(
      categoryRankTriggerIds(
        snapshot({ categoryIds: ['cat-a', 'cat-b'] }),
        snapshot({ categoryIds: ['cat-b', 'cat-a'] }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['name', { name: 'Atlas Slots 2' }],
    ['active state', { isActive: false }],
    ['provider', { providerId: 'provider-2' }],
  ] as const)('returns every category of the game when only the %s changed', (_label, change) => {
    expect([...categoryRankTriggerIds(snapshot({}), snapshot({ ...change }))].sort()).toEqual([
      'cat-a',
      'cat-b',
    ]);
  });

  it('returns the union without duplicates when membership alone changed', () => {
    expect(
      [
        ...categoryRankTriggerIds(
          snapshot({ categoryIds: ['cat-a', 'cat-b'] }),
          snapshot({ categoryIds: ['cat-b', 'cat-c'] }),
        ),
      ].sort(),
    ).toEqual(['cat-a', 'cat-b', 'cat-c']);
  });

  it('detects a membership change of equal size', () => {
    expect(
      categoryRankTriggerIds(
        snapshot({ categoryIds: ['cat-a'] }),
        snapshot({ categoryIds: ['cat-z'] }),
      ),
    ).toHaveLength(2);
  });

  it('detects a game gaining its first category', () => {
    expect(
      categoryRankTriggerIds(snapshot({ categoryIds: [] }), snapshot({ categoryIds: ['cat-a'] })),
    ).toEqual(['cat-a']);
  });

  it('detects a game losing its last category', () => {
    expect(
      categoryRankTriggerIds(snapshot({ categoryIds: ['cat-a'] }), snapshot({ categoryIds: [] })),
    ).toEqual(['cat-a']);
  });

  it('treats duplicated category ids in one snapshot as the same set', () => {
    expect(
      categoryRankTriggerIds(
        snapshot({ categoryIds: ['cat-a', 'cat-a'] }),
        snapshot({ categoryIds: ['cat-a', 'cat-a'] }),
      ),
    ).toEqual([]);
  });

  it('never returns duplicates and always covers both sides when something changed', () => {
    const ids = fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 6 });
    fc.assert(
      fc.property(ids, ids, (before, after) => {
        const result = categoryRankTriggerIds(
          snapshot({ categoryIds: before }),
          snapshot({ categoryIds: after, isActive: false }),
        );
        expect(new Set(result).size).toBe(result.length);
        expect([...result].sort()).toEqual([...new Set([...before, ...after])].sort());
      }),
    );
  });
});

describe('groupRows', () => {
  it('returns an empty map for no rows', () => {
    expect(
      groupRows(
        [],
        () => 'k',
        () => 'v',
      ).size,
    ).toBe(0);
  });

  it('keeps the row order inside each owner list', () => {
    const rows = [
      { owner: 'a', value: 3 },
      { owner: 'b', value: 1 },
      { owner: 'a', value: 1 },
      { owner: 'a', value: 2 },
    ];
    const grouped = groupRows(
      rows,
      (row) => row.owner,
      (row) => row.value,
    );
    expect(grouped.get('a')).toEqual([3, 1, 2]);
    expect(grouped.get('b')).toEqual([1]);
  });

  it('keeps duplicate values', () => {
    const grouped = groupRows(
      ['x', 'x'],
      () => 'k',
      (row) => row,
    );
    expect(grouped.get('k')).toEqual(['x', 'x']);
  });

  it('loses no row and puts each row under its own key', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ owner: fc.constantFrom('a', 'b', 'c'), value: fc.integer() })),
        (rows) => {
          const grouped = groupRows(
            rows,
            (row) => row.owner,
            (row) => row.value,
          );
          expect([...grouped.values()].flat()).toHaveLength(rows.length);
          for (const [owner, values] of grouped) {
            expect(values).toEqual(
              rows.filter((row) => row.owner === owner).map((row) => row.value),
            );
          }
        },
      ),
    );
  });
});

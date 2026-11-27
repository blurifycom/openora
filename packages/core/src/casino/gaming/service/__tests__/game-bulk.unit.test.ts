import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dedupe, groupAddedLinks, groupIdsByStatus, sortIds } from '../game-bulk.service.js';

describe('dedupe', () => {
  it('returns an empty list for undefined', () => {
    expect(dedupe(undefined)).toEqual([]);
  });

  it('lowercases ids and removes the duplicates the lowercasing creates', () => {
    expect(dedupe(['AB', 'ab', 'Cd', 'cd', 'AB'])).toEqual(['ab', 'cd']);
  });

  it('keeps first-seen order', () => {
    expect(dedupe(['c', 'a', 'b', 'a'])).toEqual(['c', 'a', 'b']);
  });

  it('is idempotent and lowercase for any input', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (ids) => {
        const once = dedupe(ids);
        expect(dedupe(once)).toEqual(once);
        expect(once.every((id) => id === id.toLowerCase())).toBe(true);
        expect(new Set(once).size).toBe(once.length);
      }),
    );
  });
});

describe('sortIds', () => {
  it('does not mutate its input', () => {
    const input = ['b', 'a'];
    sortIds(input);
    expect(input).toEqual(['b', 'a']);
  });

  it('sorts so two orders of the same ids lock in the same order', () => {
    fc.assert(
      fc.property(fc.array(fc.uuid()), (ids) => {
        expect(sortIds(ids)).toEqual(sortIds([...ids].reverse()));
      }),
    );
  });
});

describe('groupIdsByStatus', () => {
  const rows = [
    { id: 'c', reviewStatus: 'pending' },
    { id: 'a', reviewStatus: 'declined' },
    { id: 'b', reviewStatus: 'pending' },
    { id: 'd', reviewStatus: 'approved' },
    { id: 'e', reviewStatus: 'pending' },
  ] as const;

  it('groups unreviewed kept rows by status with sorted ids', () => {
    expect(groupIdsByStatus(rows, new Set(['a', 'b', 'c']))).toEqual([
      ['pending', ['b', 'c']],
      ['declined', ['a']],
    ]);
  });

  it('drops approved rows even when kept', () => {
    expect(groupIdsByStatus(rows, new Set(['d']))).toEqual([]);
  });

  it('drops rows that are not in the keep set', () => {
    expect(groupIdsByStatus(rows, new Set())).toEqual([]);
  });

  it('returns nothing for no rows', () => {
    expect(groupIdsByStatus([], new Set(['a']))).toEqual([]);
  });
});

describe('groupAddedLinks', () => {
  it('groups link ids per game, sorted, with games in ascending id order', () => {
    expect(
      groupAddedLinks(
        [
          { game_id: 'g2', tag_id: 't2' },
          { game_id: 'g1', tag_id: 't3' },
          { game_id: 'g2', tag_id: 't1' },
          { game_id: 'g1', tag_id: 't1' },
        ],
        'tag_id',
        'tagIds',
      ),
    ).toEqual([
      { gameId: 'g1', tagIds: ['t1', 't3'] },
      { gameId: 'g2', tagIds: ['t1', 't2'] },
    ]);
  });

  it('returns nothing for no rows', () => {
    expect(groupAddedLinks([], 'tag_id', 'tagIds')).toEqual([]);
  });

  it('keeps every link and orders games the same for any row order', () => {
    const row = fc.record({
      game_id: fc.constantFrom('g1', 'g2', 'g3'),
      category_id: fc.constantFrom('c1', 'c2', 'c3', 'c4'),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(row, { selector: (r) => `${r.game_id}${r.category_id}` }),
        (rows) => {
          const forward = groupAddedLinks(rows, 'category_id', 'categoryIds');
          const backward = groupAddedLinks([...rows].reverse(), 'category_id', 'categoryIds');
          expect(forward).toEqual(backward);
          expect(forward.flatMap((entry) => entry.categoryIds)).toHaveLength(rows.length);
        },
      ),
    );
  });
});

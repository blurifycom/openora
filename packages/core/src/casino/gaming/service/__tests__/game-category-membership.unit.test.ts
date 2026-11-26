import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GameCategoryMembershipContendedError,
  diffMembership,
  failureReason,
} from '../game-category-membership.service.js';
import {
  GameCategoryRuleInvalidError,
  GameCategoryRuleTooBroadError,
  GameCategoryRuleUnavailableError,
} from '../game-category-rule.service.js';

describe('diffMembership', () => {
  it.each([
    ['both empty', [], [], [], []],
    ['all new', [], ['a', 'b'], ['a', 'b'], []],
    ['all gone', ['a', 'b'], [], [], ['a', 'b']],
    ['identical', ['a', 'b'], ['b', 'a'], [], []],
    ['mixed', ['a', 'b'], ['b', 'c'], ['c'], ['a']],
  ])('%s', (_label, current, matched, toAdd, toRemove) => {
    expect(diffMembership(current, matched)).toEqual({ toAdd, toRemove });
  });

  it('collapses duplicated ids on either side', () => {
    expect(diffMembership(['a', 'a'], ['b', 'b', 'a'])).toEqual({ toAdd: ['b'], toRemove: [] });
  });

  it('keeps matched order for additions', () => {
    expect(diffMembership([], ['c', 'a', 'b']).toAdd).toEqual(['c', 'a', 'b']);
  });

  it('is case sensitive, so an uppercase id is a different game', () => {
    expect(diffMembership(['a'], ['A'])).toEqual({ toAdd: ['A'], toRemove: ['a'] });
  });

  it('turns current into matched when applied, with disjoint adds and removes', () => {
    const ids = fc.array(fc.constantFrom<string>('a', 'b', 'c', 'd', 'e', 'f'), { maxLength: 10 });
    fc.assert(
      fc.property(ids, ids, (current, matched) => {
        const { toAdd, toRemove } = diffMembership(current, matched);
        const applied = new Set([...current].filter((id) => !toRemove.includes(id)));
        for (const id of toAdd) {
          applied.add(id);
        }
        expect([...applied].sort()).toEqual([...new Set(matched)].sort());
        expect(toAdd.filter((id) => toRemove.includes(id))).toEqual([]);
        expect(toAdd.filter((id) => current.includes(id))).toEqual([]);
        expect(toRemove.filter((id) => matched.includes(id))).toEqual([]);
      }),
    );
  });

  it('is empty when the two sets are equal regardless of order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 50 })), (ids) => {
        const reversed = [...ids].reverse();
        expect(diffMembership(ids.map(String), reversed.map(String))).toEqual({
          toAdd: [],
          toRemove: [],
        });
      }),
    );
  });
});

describe('failureReason', () => {
  it.each([
    ['invalid rule', new GameCategoryRuleInvalidError('providers: bad params')],
    ['too broad rule', new GameCategoryRuleTooBroadError(9000)],
    ['unavailable definition', new GameCategoryRuleUnavailableError('tags: could not resolve')],
    ['contended evaluation', new GameCategoryMembershipContendedError('cat-1')],
  ])('passes the own message of a %s through', (_label, error) => {
    expect(failureReason(error)).toBe(error.message);
  });

  it.each([
    ['plain error carrying a secret', new Error('password=hunter2 at db.internal')],
    ['string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['object with a message', { message: 'leak' }],
  ])('hides a %s behind a fixed message', (_label, error) => {
    expect(failureReason(error)).toBe('The rule could not be evaluated');
  });

  it('cuts an oversize own message to 500 characters', () => {
    const reason = failureReason(new GameCategoryRuleInvalidError('x'.repeat(2000)));
    expect(reason).toHaveLength(500);
  });

  it('keeps a message of exactly 500 characters whole', () => {
    expect(failureReason(new GameCategoryRuleInvalidError('y'.repeat(500)))).toBe('y'.repeat(500));
  });

  it('never exceeds 500 characters for any message', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1500 }), (message) => {
        expect(failureReason(new GameCategoryRuleInvalidError(message)).length).toBeLessThanOrEqual(
          500,
        );
      }),
    );
  });
});

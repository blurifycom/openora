import { describe, expect, it } from 'vitest';
import { diffMembership } from '../game-category-membership.service.js';

describe('diffMembership', () => {
  it('adds ids matched but not current', () => {
    expect(diffMembership(['a'], ['a', 'b', 'c']).toAdd).toEqual(['b', 'c']);
  });

  it('removes ids current but not matched', () => {
    expect(diffMembership(['a', 'b', 'c'], ['b']).toRemove).toEqual(['a', 'c']);
  });

  it('returns nothing to do when both sets are equal', () => {
    expect(diffMembership(['a', 'b'], ['b', 'a'])).toEqual({ toAdd: [], toRemove: [] });
  });

  it('treats duplicate ids as one', () => {
    expect(diffMembership(['a', 'a'], ['a', 'b', 'b'])).toEqual({ toAdd: ['b'], toRemove: [] });
    expect(diffMembership(['a', 'a', 'c'], ['c'])).toEqual({ toAdd: [], toRemove: ['a'] });
  });

  it('adds all ids when the category is empty and removes all when nothing matches', () => {
    expect(diffMembership([], ['a', 'b'])).toEqual({ toAdd: ['a', 'b'], toRemove: [] });
    expect(diffMembership(['a', 'b'], [])).toEqual({ toAdd: [], toRemove: ['a', 'b'] });
  });
});

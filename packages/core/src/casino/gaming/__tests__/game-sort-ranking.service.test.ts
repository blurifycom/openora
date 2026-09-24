import { describe, it, expect } from 'vitest';
import { mergePinnedOrder } from '../service/game-sort-ranking.service.js';

describe('mergePinnedOrder', () => {
  it('returns an empty list for an empty input', () => {
    expect(mergePinnedOrder([], new Map([['a', 0]]))).toEqual([]);
  });

  it('returns the input unchanged when there are no pins', () => {
    expect(mergePinnedOrder(['a', 'b', 'c'], new Map())).toEqual(['a', 'b', 'c']);
  });

  it('holds a single pin at slot 0, filling the rest in relative order', () => {
    expect(mergePinnedOrder(['a', 'b', 'c'], new Map([['c', 0]]))).toEqual(['c', 'a', 'b']);
  });

  it('holds several pins at their slots, filling the gaps in relative order', () => {
    const result = mergePinnedOrder(
      ['a', 'b', 'c', 'd', 'e'],
      new Map([
        ['b', 0],
        ['d', 2],
      ]),
    );
    expect(result).toEqual(['b', 'a', 'd', 'c', 'e']);
  });

  it('clamps a slot past the end of the list to the last position', () => {
    expect(mergePinnedOrder(['a', 'b', 'c'], new Map([['a', 10]]))).toEqual(['b', 'c', 'a']);
  });

  it('stacks several overflowing pins at the tail, in ascending slot order', () => {
    const result = mergePinnedOrder(
      ['a', 'b', 'c', 'd', 'e'],
      new Map([
        ['a', 10],
        ['b', 11],
        ['c', 12],
      ]),
    );
    expect(result).toEqual(['d', 'e', 'a', 'b', 'c']);
  });

  it('keeps an in-range pin at its slot while overflowing pins stack behind it', () => {
    const result = mergePinnedOrder(
      ['a', 'b', 'c', 'd', 'e'],
      new Map([
        ['a', 1],
        ['b', 9],
        ['c', 12],
      ]),
    );
    expect(result).toEqual(['d', 'a', 'e', 'b', 'c']);
  });

  it('ignores a pin whose game id is not present in the order', () => {
    expect(
      mergePinnedOrder(
        ['a', 'b'],
        new Map([
          ['a', 0],
          ['not-a-member', 1],
        ]),
      ),
    ).toEqual(['a', 'b']);
  });

  it('reproduces the exact permutation when every game is pinned', () => {
    const result = mergePinnedOrder(
      ['a', 'b', 'c'],
      new Map([
        ['a', 2],
        ['b', 0],
        ['c', 1],
      ]),
    );
    expect(result).toEqual(['b', 'c', 'a']);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mergePinnedOrder } from '../game-sort-ranking.service.js';

const pins = (entries: Array<[string, number]>) => new Map(entries);

describe('mergePinnedOrder', () => {
  it.each([
    ['no pins', ['a', 'b', 'c'], [], ['a', 'b', 'c']],
    ['empty order', [], [['a', 0]], []],
    ['pin to the top', ['a', 'b', 'c'], [['c', 0]], ['c', 'a', 'b']],
    ['pin to the middle', ['a', 'b', 'c', 'd'], [['d', 1]], ['a', 'd', 'b', 'c']],
    ['pin already at its slot', ['a', 'b', 'c'], [['b', 1]], ['a', 'b', 'c']],
    ['slot past the end clamps to the tail', ['a', 'b', 'c'], [['a', 99]], ['b', 'c', 'a']],
    ['pin to the last slot', ['a', 'b', 'c'], [['a', 2]], ['b', 'c', 'a']],
    [
      'two pins',
      ['a', 'b', 'c', 'd'],
      [
        ['d', 0],
        ['c', 3],
      ],
      ['d', 'a', 'b', 'c'],
    ],
    [
      'pins given in reverse slot order',
      ['a', 'b', 'c', 'd'],
      [
        ['c', 3],
        ['d', 0],
      ],
      ['d', 'a', 'b', 'c'],
    ],
    [
      'overflowing pins stack in ascending slot order',
      ['a', 'b', 'c'],
      [
        ['a', 50],
        ['b', 40],
      ],
      ['c', 'b', 'a'],
    ],
    ['pin for a game not in the order is ignored', ['a', 'b'], [['zzz', 0]], ['a', 'b']],
    [
      'two pins on the same slot',
      ['a', 'b', 'c'],
      [
        ['b', 0],
        ['c', 0],
      ],
      ['c', 'b', 'a'],
    ],
  ] as const)('%s', (_label, order, entries, expected) => {
    expect(mergePinnedOrder(order, pins(entries.map(([id, slot]) => [id, slot])))).toEqual(
      expected,
    );
  });

  it('does not mutate its input', () => {
    const order = ['a', 'b', 'c'];
    mergePinnedOrder(order, pins([['c', 0]]));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  const ids = fc.uniqueArray(
    fc.integer({ min: 0, max: 60 }).map((n) => `g${n}`),
    { maxLength: 25 },
  );
  const slots = fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 25 });
  const orderAndPins = fc.tuple(ids, slots, fc.array(fc.boolean(), { maxLength: 25 }));

  const build = (order: string[], slotList: number[], chosen: boolean[]) =>
    new Map(
      order.flatMap((id, index) => {
        const slot = slotList[index];
        return chosen[index] === true && slot !== undefined ? [[id, slot] as const] : [];
      }),
    );

  it('returns every id exactly once, never losing or duplicating one', () => {
    fc.assert(
      fc.property(orderAndPins, ([order, slotList, chosen]) => {
        const result = mergePinnedOrder(order, build(order, slotList, chosen));
        expect([...result].sort()).toEqual([...order].sort());
      }),
    );
  });

  it('keeps the unpinned ids in their original relative order', () => {
    fc.assert(
      fc.property(orderAndPins, ([order, slotList, chosen]) => {
        const pinMap = build(order, slotList, chosen);
        const result = mergePinnedOrder(order, pinMap);
        expect(result.filter((id) => !pinMap.has(id))).toEqual(
          order.filter((id) => !pinMap.has(id)),
        );
      }),
    );
  });

  it('places each pin on its exact slot when every slot is distinct and within the unpinned length', () => {
    fc.assert(
      fc.property(ids, fc.array(fc.boolean(), { maxLength: 25 }), (order, chosen) => {
        const pinned = order.filter((_, index) => chosen[index] === true);
        const restLength = order.length - pinned.length;
        const slotCount = Math.min(pinned.length, restLength + 1);
        const pinMap = new Map(pinned.slice(0, slotCount).map((id, index) => [id, index] as const));
        const result = mergePinnedOrder(
          order.filter((id) => !pinned.includes(id) || pinMap.has(id)),
          pinMap,
        );
        for (const [id, slot] of pinMap) {
          expect(result[slot]).toBe(id);
        }
      }),
    );
  });

  it('gives the same result for the same pins however the map was built', () => {
    fc.assert(
      fc.property(orderAndPins, ([order, slotList, chosen]) => {
        const entries = [...build(order, slotList, chosen)];
        const forward = mergePinnedOrder(order, new Map(entries));
        const backward = mergePinnedOrder(order, new Map([...entries].reverse()));
        expect(backward).toEqual(forward);
      }),
    );
  });
});

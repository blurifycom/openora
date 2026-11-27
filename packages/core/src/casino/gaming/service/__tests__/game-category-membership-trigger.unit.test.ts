import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  membershipChangeForGameUpdate,
  mergeChanges,
} from '../game-category-membership-trigger.service.js';

type Snapshot = Parameters<typeof membershipChangeForGameUpdate>[0];

const snapshot = (over: Partial<Snapshot>): Snapshot => ({
  providerId: 'p1',
  isActive: true,
  tagIds: ['t1', 't2'],
  ...over,
});

describe('membershipChangeForGameUpdate', () => {
  it('returns null when nothing a rule could care about changed', () => {
    expect(membershipChangeForGameUpdate(snapshot({}), snapshot({}))).toBeNull();
  });

  it('ignores a reordering of the same tags', () => {
    expect(
      membershipChangeForGameUpdate(
        snapshot({ tagIds: ['t1', 't2'] }),
        snapshot({ tagIds: ['t2', 't1'] }),
      ),
    ).toBeNull();
  });

  it('reports both providers and a possible playability flip when the provider moved', () => {
    expect(membershipChangeForGameUpdate(snapshot({}), snapshot({ providerId: 'p2' }))).toEqual({
      providerIds: ['p1', 'p2'],
      tagIds: [],
      playabilityChanged: true,
    });
  });

  it.each([
    [true, false],
    [false, true],
  ])('reports a playability flip alone when active goes %s to %s', (before, after) => {
    expect(
      membershipChangeForGameUpdate(snapshot({ isActive: before }), snapshot({ isActive: after })),
    ).toEqual({ providerIds: [], tagIds: [], playabilityChanged: true });
  });

  it('reports the added and removed tags without touching providers or playability', () => {
    expect(
      membershipChangeForGameUpdate(
        snapshot({ tagIds: ['t1', 't2'] }),
        snapshot({ tagIds: ['t2', 't3'] }),
      ),
    ).toEqual({ providerIds: [], tagIds: ['t1', 't3'], playabilityChanged: false });
  });

  it('reports a first tag and a last tag removed', () => {
    expect(
      membershipChangeForGameUpdate(snapshot({ tagIds: [] }), snapshot({ tagIds: ['t9'] }))?.tagIds,
    ).toEqual(['t9']);
    expect(
      membershipChangeForGameUpdate(snapshot({ tagIds: ['t9'] }), snapshot({ tagIds: [] }))?.tagIds,
    ).toEqual(['t9']);
  });

  it('is null exactly when provider, active state and tag set are all equal', () => {
    const tags = fc.uniqueArray(fc.constantFrom('t1', 't2', 't3', 't4'));
    fc.assert(
      fc.property(
        fc.constantFrom('p1', 'p2'),
        fc.constantFrom('p1', 'p2'),
        fc.boolean(),
        fc.boolean(),
        tags,
        tags,
        (beforeProvider, afterProvider, beforeActive, afterActive, beforeTags, afterTags) => {
          const result = membershipChangeForGameUpdate(
            snapshot({ providerId: beforeProvider, isActive: beforeActive, tagIds: beforeTags }),
            snapshot({ providerId: afterProvider, isActive: afterActive, tagIds: afterTags }),
          );
          const unchanged =
            beforeProvider === afterProvider &&
            beforeActive === afterActive &&
            [...beforeTags].sort().join() === [...afterTags].sort().join();
          expect(result === null).toBe(unchanged);
        },
      ),
    );
  });

  it('flips symmetrically: a change and its reverse touch the same tags', () => {
    const tags = fc.uniqueArray(fc.constantFrom('t1', 't2', 't3', 't4'));
    fc.assert(
      fc.property(tags, tags, (a, b) => {
        const forward = membershipChangeForGameUpdate(
          snapshot({ tagIds: a }),
          snapshot({ tagIds: b }),
        );
        const backward = membershipChangeForGameUpdate(
          snapshot({ tagIds: b }),
          snapshot({ tagIds: a }),
        );
        expect([...(forward?.tagIds ?? [])].sort()).toEqual([...(backward?.tagIds ?? [])].sort());
      }),
    );
  });
});

describe('mergeChanges', () => {
  it('merges nothing into an empty change', () => {
    expect(mergeChanges([])).toEqual({ providerIds: [], tagIds: [], playabilityChanged: false });
  });

  it('unions ids without duplicates and ors the playability flag', () => {
    expect(
      mergeChanges([
        { providerIds: ['p1', 'p2'], tagIds: ['t1'], playabilityChanged: false },
        { providerIds: ['p2', 'p3'], tagIds: ['t1', 't2'], playabilityChanged: true },
        { providerIds: [], tagIds: [], playabilityChanged: false },
      ]),
    ).toEqual({ providerIds: ['p1', 'p2', 'p3'], tagIds: ['t1', 't2'], playabilityChanged: true });
  });

  it('gives the same sets and flag in any order', () => {
    const change = fc.record({
      providerIds: fc.array(fc.constantFrom('p1', 'p2', 'p3')),
      tagIds: fc.array(fc.constantFrom('t1', 't2', 't3')),
      playabilityChanged: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(change, { maxLength: 6 }), (changes) => {
        const forward = mergeChanges(changes);
        const backward = mergeChanges([...changes].reverse());
        expect([...forward.providerIds].sort()).toEqual([...backward.providerIds].sort());
        expect([...forward.tagIds].sort()).toEqual([...backward.tagIds].sort());
        expect(forward.playabilityChanged).toBe(backward.playabilityChanged);
        expect(new Set(forward.providerIds).size).toBe(forward.providerIds.length);
      }),
    );
  });
});

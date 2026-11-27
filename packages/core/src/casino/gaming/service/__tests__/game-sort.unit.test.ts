import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { createGameSortCatalog, defineGameSort } from '@openora/core/contracts';
import { GameSortConfigInvalidError, GameSortService } from '../game-sort.service.js';

const popularity = defineGameSort({
  key: 'popularity',
  directions: ['desc'],
  paramsSchema: z.object({ windowDays: z.number().int().min(1).default(7) }),
  rank: async () => [],
});

const alphabetical = defineGameSort({
  key: 'alphabetical',
  directions: ['asc', 'desc'],
  paramsSchema: z.object({}),
  rank: async () => [],
});

const newest = defineGameSort({
  key: 'newest',
  directions: ['desc', 'asc'],
  paramsSchema: z.object({}),
  rank: async () => [],
});

const dated = defineGameSort({
  key: 'dated',
  directions: ['asc', 'desc'],
  paramsSchema: z.object({ since: z.coerce.date() }),
  rank: async () => [],
});

const service = new GameSortService(
  createGameSortCatalog([popularity, alphabetical, newest, dated]),
);

type Existing = Parameters<typeof service.resolvePatch>[0];
type Input = Parameters<typeof service.resolvePatch>[1];

const existing = (over: Partial<Existing>): Existing => ({
  sortKey: 'alphabetical',
  sortDirection: 'asc',
  sortParams: {},
  ...over,
});

describe('requireDefinition', () => {
  it('returns the definition of a known key', () => {
    expect(service.requireDefinition('popularity')).toBe(popularity);
  });

  it.each(['missing', '', 'Popularity', 'popularity '])('rejects the unknown key %j', (key) => {
    expect(() => service.requireDefinition(key)).toThrow(GameSortConfigInvalidError);
  });
});

describe('resolvePatch', () => {
  it('reports no change for an empty input', () => {
    const result = service.resolvePatch(existing({}), {});
    expect(result.changed).toBe(false);
    expect(result.patch).toEqual({ sortKey: 'alphabetical', sortDirection: 'asc', sortParams: {} });
  });

  it('rejects a direction the key does not allow', () => {
    expect(() =>
      service.resolvePatch(existing({ sortKey: 'popularity', sortDirection: null }), {
        sortDirection: 'asc',
      }),
    ).toThrow("'asc' is not a valid direction for sort 'popularity'");
  });

  it('validates the direction against the new key when the key changes in the same patch', () => {
    expect(() =>
      service.resolvePatch(existing({}), { sortKey: 'popularity', sortDirection: 'asc' }),
    ).toThrow(GameSortConfigInvalidError);
  });

  it('stores no direction for a single-direction key', () => {
    const result = service.resolvePatch(existing({}), { sortKey: 'popularity' });
    expect(result.patch.sortDirection).toBeNull();
    expect(result.changed).toBe(true);
  });

  it('keeps the existing direction when the key is unchanged', () => {
    expect(service.resolvePatch(existing({ sortDirection: 'desc' }), {}).patch.sortDirection).toBe(
      'desc',
    );
  });

  it('resets to the first direction of a new key instead of carrying the old one', () => {
    const result = service.resolvePatch(existing({ sortKey: 'popularity', sortDirection: null }), {
      sortKey: 'alphabetical',
    });
    expect(result.patch.sortDirection).toBe('asc');
  });

  it('resets a carried direction to the first one when the key changes between multi-direction keys', () => {
    const result = service.resolvePatch(existing({ sortDirection: 'asc' }), { sortKey: 'newest' });
    expect(result.patch.sortDirection).toBe('desc');
  });

  it('treats an explicit null direction as the first direction', () => {
    expect(
      service.resolvePatch(existing({ sortDirection: 'desc' }), { sortDirection: null }).patch
        .sortDirection,
    ).toBe('asc');
  });

  it('falls back to the first direction when the stored one is null on a multi-direction key', () => {
    expect(service.resolvePatch(existing({ sortDirection: null }), {}).patch.sortDirection).toBe(
      'asc',
    );
  });

  it('reports a change when only the direction flips', () => {
    expect(service.resolvePatch(existing({}), { sortDirection: 'desc' })).toMatchObject({
      changed: true,
      patch: { sortDirection: 'desc' },
    });
  });

  it('clears params when the key changes and none are given', () => {
    const result = service.resolvePatch(existing({ sortParams: { stale: true } }), {
      sortKey: 'popularity',
    });
    expect(result.patch.sortParams).toEqual({ windowDays: 7 });
  });

  it('keeps stored params when the key is unchanged and none are given', () => {
    const result = service.resolvePatch(
      existing({ sortKey: 'popularity', sortDirection: null, sortParams: { windowDays: 30 } }),
      {},
    );
    expect(result.patch.sortParams).toEqual({ windowDays: 30 });
    expect(result.changed).toBe(false);
  });

  it('stores the schema-parsed params, so defaults count as a change from empty stored params', () => {
    const result = service.resolvePatch(
      existing({ sortKey: 'popularity', sortDirection: null, sortParams: {} }),
      {},
    );
    expect(result.patch.sortParams).toEqual({ windowDays: 7 });
    expect(result.changed).toBe(true);
  });

  it.each([
    ['below the minimum', { windowDays: 0 }],
    ['wrong type', { windowDays: '7' }],
    ['fractional', { windowDays: 1.5 }],
  ])('rejects params %s', (_label, sortParams) => {
    const input: Input = { sortKey: 'popularity', sortParams };
    expect(() => service.resolvePatch(existing({}), input)).toThrow(
      "Invalid sortParams for sort 'popularity'",
    );
  });

  it('rejects params whose parsed form is not plain JSON', () => {
    expect(() =>
      service.resolvePatch(existing({ sortKey: 'dated' }), { sortParams: { since: '2026-01-01' } }),
    ).toThrow(GameSortConfigInvalidError);
  });

  it('rejects an unknown key before reading anything else', () => {
    expect(() => service.resolvePatch(existing({}), { sortKey: 'nope' })).toThrow(
      'Unknown sort key: nope',
    );
  });
});

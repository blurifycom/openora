import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PluginEntry } from '../load-plugins.js';
import { applyServiceManifest, parseServiceManifest } from '../service-manifest.js';

const entry = (id: string, over: Partial<PluginEntry> = {}): PluginEntry => ({
  id,
  path: `/plugins/${id}.js`,
  ...over,
});

const ENTRIES = [
  entry('identity'),
  entry('wallet'),
  entry('casino'),
  entry('redis-broker', { kind: 'infra' }),
];

describe('parseServiceManifest', () => {
  it.each([[undefined], [''], ['  '], [', ,']])('treats %j as no manifest', (raw) => {
    expect(parseServiceManifest(raw)).toBeNull();
  });

  it.each([
    ['wallet', [{ id: 'wallet', noRoutes: false }]],
    [
      'wallet, casino',
      [
        { id: 'wallet', noRoutes: false },
        { id: 'casino', noRoutes: false },
      ],
    ],
    [
      'wallet\ncasino:no-routes',
      [
        { id: 'wallet', noRoutes: false },
        { id: 'casino', noRoutes: true },
      ],
    ],
    ['wallet,wallet', [{ id: 'wallet', noRoutes: false }]],
    ['identity:no-routes,identity:no-routes', [{ id: 'identity', noRoutes: true }]],
  ])('parses %j', (raw, expected) => {
    expect(parseServiceManifest(raw)).toEqual(expected);
  });

  it.each([
    ['an unknown flag', 'wallet:routes'],
    ['an empty flag', 'wallet:'],
    ['two flags', 'wallet:no-routes:no-routes'],
    ['an upper case flag', 'wallet:NO-ROUTES'],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseServiceManifest(raw)).toThrow(/unknown flag/);
  });

  it('refuses one id both with and without no-routes', () => {
    expect(() => parseServiceManifest('wallet,wallet:no-routes')).toThrow(/both with and without/);
  });
});

describe('applyServiceManifest', () => {
  it('returns every entry without a manifest', () => {
    expect(applyServiceManifest(ENTRIES, null)).toBe(ENTRIES);
  });

  it('keeps the listed modules and every infra overlay in plugin-list order', () => {
    expect(
      applyServiceManifest(ENTRIES, [
        { id: 'casino', noRoutes: false },
        { id: 'identity', noRoutes: false },
      ]).map((e) => e.id),
    ).toEqual(['identity', 'casino', 'redis-broker']);
  });

  it('marks a no-routes module and leaves the others untouched', () => {
    const selected = applyServiceManifest(ENTRIES, [
      { id: 'wallet', noRoutes: false },
      { id: 'identity', noRoutes: true },
    ]);
    expect(selected.find((e) => e.id === 'identity')?.noRoutes).toBe(true);
    expect(selected.find((e) => e.id === 'wallet')?.noRoutes).toBeUndefined();
  });

  it('does not mutate the entries it marks', () => {
    applyServiceManifest(ENTRIES, [{ id: 'identity', noRoutes: true }]);
    expect(ENTRIES[0]?.noRoutes).toBeUndefined();
  });

  it('refuses an unknown module id and names it', () => {
    expect(() => applyServiceManifest(ENTRIES, [{ id: 'sportsbook', noRoutes: false }])).toThrow(
      /unknown module id\(s\): sportsbook/,
    );
  });

  it('refuses an id that differs only by case', () => {
    expect(() => applyServiceManifest(ENTRIES, [{ id: 'Wallet', noRoutes: false }])).toThrow(
      /unknown module id/,
    );
  });

  it('refuses no-routes on an infra overlay', () => {
    expect(() => applyServiceManifest(ENTRIES, [{ id: 'redis-broker', noRoutes: true }])).toThrow(
      /infra overlay/,
    );
  });

  it('round trips a parsed manifest into the same selection whatever the order', () => {
    const ids = ['identity', 'wallet', 'casino'];
    fc.assert(
      fc.property(fc.shuffledSubarray(ids, { minLength: 1 }), (picked) => {
        const forward = applyServiceManifest(ENTRIES, parseServiceManifest(picked.join(',')));
        const backward = applyServiceManifest(
          ENTRIES,
          parseServiceManifest([...picked].reverse().join(' ')),
        );
        expect(backward).toEqual(forward);
        expect(forward.map((e) => e.id)).toEqual(
          ENTRIES.filter((e) => e.kind === 'infra' || picked.includes(e.id)).map((e) => e.id),
        );
      }),
    );
  });
});

import { describe, it, expect } from 'vitest';
import { applyServiceManifest, parseServiceManifest } from '../service-manifest.js';
import type { PluginEntry } from '../load-plugins.js';

const plain = (id: string) => ({ id, noRoutes: false });

const entries: PluginEntry[] = [
  { id: 'identity', path: 'a' },
  { id: 'wallet', path: 'b' },
  { id: 'gaming', path: 'c' },
  { id: 'rabbitmq', path: 'd', kind: 'infra' },
  { id: 'bullmq', path: 'e', kind: 'infra' },
];

describe('parseServiceManifest', () => {
  it('returns null (monolith) when unset or empty', () => {
    expect(parseServiceManifest(undefined)).toBeNull();
    expect(parseServiceManifest('')).toBeNull();
    expect(parseServiceManifest('   ')).toBeNull();
  });

  it('splits on commas and whitespace, trimming blanks', () => {
    expect(parseServiceManifest('identity, wallet')).toEqual([plain('identity'), plain('wallet')]);
    expect(parseServiceManifest('identity  wallet')).toEqual([plain('identity'), plain('wallet')]);
    expect(parseServiceManifest('wallet,')).toEqual([plain('wallet')]);
  });

  it('reads the :no-routes suffix as a per-id flag', () => {
    expect(parseServiceManifest('wallet,identity:no-routes')).toEqual([
      plain('wallet'),
      { id: 'identity', noRoutes: true },
    ]);
  });

  it('rejects an unknown flag, an empty flag and a contradictory repeat', () => {
    expect(() => parseServiceManifest('identity:noroutes')).toThrow(/unknown flag/);
    expect(() => parseServiceManifest('identity:')).toThrow(/unknown flag/);
    expect(() => parseServiceManifest('identity:no-routes:x')).toThrow(/unknown flag/);
    expect(() => parseServiceManifest('identity,identity:no-routes')).toThrow(
      /both with and without/,
    );
  });
});

describe('applyServiceManifest', () => {
  it('returns every entry for the monolith (null manifest)', () => {
    expect(applyServiceManifest(entries, null)).toHaveLength(entries.length);
  });

  it('keeps the named modules plus all infra overlays', () => {
    const selected = applyServiceManifest(entries, [plain('wallet')]);
    expect(selected.map((e) => e.id).sort()).toEqual(['bullmq', 'rabbitmq', 'wallet']);
  });

  it('marks only the flagged entries noRoutes, and keeps them', () => {
    const selected = applyServiceManifest(entries, [
      plain('wallet'),
      { id: 'identity', noRoutes: true },
    ]);
    expect(selected.find((e) => e.id === 'identity')?.noRoutes).toBe(true);
    expect(selected.find((e) => e.id === 'wallet')?.noRoutes).toBeUndefined();
    expect(selected.find((e) => e.id === 'gaming')).toBeUndefined();
  });

  it('throws on the flag for an unknown id', () => {
    expect(() => applyServiceManifest(entries, [{ id: 'nope', noRoutes: true }])).toThrow(
      /unknown module id/,
    );
  });

  it('throws on the flag for an infra overlay', () => {
    expect(() => applyServiceManifest(entries, [{ id: 'rabbitmq', noRoutes: true }])).toThrow(
      /infra overlay/,
    );
  });

  it('throws on an unknown id', () => {
    expect(() => applyServiceManifest(entries, [plain('nope')])).toThrow(/unknown module id/);
  });
});

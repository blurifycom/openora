import { describe, it, expect } from 'vitest';
import { applyServiceManifest, parseServiceManifest } from '../service-manifest.js';
import type { PluginEntry } from '../load-plugins.js';

const entries: PluginEntry[] = [
  { id: 'identity', path: 'a' },
  { id: 'wallet', path: 'b' },
  { id: 'sportsbook', path: 'c' },
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
    expect(parseServiceManifest('identity, wallet')).toEqual(['identity', 'wallet']);
    expect(parseServiceManifest('identity  wallet')).toEqual(['identity', 'wallet']);
    expect(parseServiceManifest('wallet,')).toEqual(['wallet']);
  });
});

describe('applyServiceManifest', () => {
  it('returns every entry for the monolith (null manifest)', () => {
    expect(applyServiceManifest(entries, null)).toHaveLength(entries.length);
  });

  it('keeps the named modules plus all infra overlays', () => {
    const selected = applyServiceManifest(entries, ['wallet']);
    expect(selected.map((e) => e.id).sort()).toEqual(['bullmq', 'rabbitmq', 'wallet']);
  });

  it('throws on an unknown id', () => {
    expect(() => applyServiceManifest(entries, ['nope'])).toThrow(/unknown module id/);
  });
});

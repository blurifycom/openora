import { describe, it, expect, vi } from 'vitest';
import {
  applyServiceManifest,
  parseServiceManifest,
  selectServiceEntries,
} from '../service-manifest.js';
import type { PluginEntry } from '../load-plugins.js';

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

describe('selectServiceEntries', () => {
  const graph: Record<string, string[]> = {
    audit: [],
    identity: ['audit'],
    wallet: ['identity', 'audit'],
    gaming: ['wallet'],
    rabbitmq: [],
    bullmq: [],
  };
  const all: PluginEntry[] = [
    { id: 'audit', path: 'a' },
    { id: 'identity', path: 'b' },
    { id: 'wallet', path: 'c' },
    { id: 'gaming', path: 'd' },
    { id: 'bullmq', path: 'e', kind: 'infra' },
  ];
  const readerOf = (deps: Record<string, string[]>) =>
    vi.fn(async (entry: PluginEntry) => deps[entry.id] ?? []);

  it('returns every entry without a manifest and reads none of them', async () => {
    const reader = readerOf(graph);

    expect(await selectServiceEntries(all, null, reader)).toBe(all);
    expect(reader).not.toHaveBeenCalled();
  });

  it('boots a manifest that lists its dependencies, reading only what it selects', async () => {
    const reader = readerOf(graph);

    const selected = await selectServiceEntries(all, ['audit', 'identity', 'wallet'], reader);

    expect(selected.map((e) => e.id)).toEqual(['audit', 'identity', 'wallet', 'bullmq']);
    expect(reader.mock.calls.map(([e]) => e.id).sort()).toEqual(
      ['audit', 'bullmq', 'identity', 'wallet'].sort(),
    );
  });

  it('names every left-out dependency, transitive ones included, in one error', async () => {
    const run = selectServiceEntries(all, ['gaming'], readerOf(graph));

    await expect(run).rejects.toThrow(
      /SERVICE_MANIFEST=gaming leaves out[\s\S]*- wallet \(required by gaming\)[\s\S]*- identity \(required by wallet\)[\s\S]*- audit \(required by wallet, identity\)[\s\S]*Add them: SERVICE_MANIFEST=gaming,wallet,identity,audit/,
    );
  });

  it("counts an infra overlay's dependencies", async () => {
    const run = selectServiceEntries(all, ['audit'], readerOf({ ...graph, bullmq: ['identity'] }));

    await expect(run).rejects.toThrow(/- identity \(required by bullmq\)/);
  });

  it('flags a dependency the plugin list does not have at all', async () => {
    const run = selectServiceEntries(all, ['audit'], readerOf({ audit: ['ghost'] }));

    await expect(run).rejects.toThrow(/- ghost \(required by audit\) - not in the plugin list/);
    await expect(run).rejects.not.toThrow(/Add them/);
  });

  it('stops on a cycle among left-out modules', async () => {
    const cyclic = { gaming: ['wallet'], wallet: ['identity'], identity: ['wallet'] };

    await expect(selectServiceEntries(all, ['gaming'], readerOf(cyclic))).rejects.toThrow(
      /Add them: SERVICE_MANIFEST=gaming,wallet,identity$/m,
    );
  });

  it('still refuses an unknown id before reading anything', async () => {
    const reader = readerOf(graph);

    await expect(selectServiceEntries(all, ['nope'], reader)).rejects.toThrow(/unknown module id/);
    expect(reader).not.toHaveBeenCalled();
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCatalog } from '@openora/core/contracts';
import { Container } from '../../kernel/index.js';
import { loadPlugins, validateEntries, type PluginEntry } from '../load-plugins.js';

const warn = vi.hoisted(() => vi.fn());

vi.mock('../../kernel/logger.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../kernel/logger.js')>();
  return {
    ...original,
    createLogger: (name: string) =>
      name === 'plugin-host'
        ? { warn, info: vi.fn(), error: vi.fn() }
        : original.createLogger(name),
  };
});

type Spec = {
  id: string;
  dependsOn?: string[];
  requires?: string[];
  optional?: string[];
  provides?: string[];
};

let fixtureCount = 0;
const dir = mkdtempSync(join(tmpdir(), 'load-plugins-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const order = (): string[] => {
  const key = Symbol.for('load-plugins.test.order');
  const holder: Record<symbol, string[] | undefined> = globalThis;
  return (holder[key] ??= []);
};

function writePlugin(file: string, spec: Spec, moduleId: string = spec.id) {
  const path = join(dir, `${file}-${fixtureCount++}.mjs`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    `const order = (globalThis[Symbol.for('load-plugins.test.order')] ??= []);
const sym = (n) => Symbol.for('load-plugins.test.port.' + n);
export default {
  id: ${JSON.stringify(moduleId)},
  dependsOn: ${JSON.stringify(spec.dependsOn ?? [])},
  requiresPorts: ${JSON.stringify(spec.requires ?? [])}.map(sym),
  optionalPorts: ${JSON.stringify(spec.optional ?? [])}.map((n) => ({ port: sym(n), without: 'skips ' + n })),
  register(ctx) {
    order.push(${JSON.stringify(spec.id)});
    for (const n of ${JSON.stringify(spec.provides ?? [])}) ctx.provide(sym(n), () => n);
  },
};
`,
  );
  return path;
}

const entry = (spec: Spec): PluginEntry => ({ id: spec.id, path: writePlugin(spec.id, spec) });
const container = () => new Container<TokenCatalog>();

beforeEach(() => {
  order().length = 0;
  warn.mockClear();
});

describe('entry validation', () => {
  it('rejects a registry that is not an array', () => {
    expect(() => validateEntries({ id: 'a', path: '/a' })).toThrow(/as an array.*Got object/);
    expect(() => validateEntries(undefined)).toThrow(/Got undefined/);
    expect(() => validateEntries('a')).toThrow(/Got string/);
  });

  it('rejects an entry that is not an object', () => {
    expect(() => validateEntries(['a'])).toThrow(/extensions\[0\] must be an object/);
    expect(() => validateEntries([null])).toThrow(/extensions\[0\] must be an object/);
    expect(() => validateEntries([{ id: 'a', path: '/a' }, 7])).toThrow(/extensions\[1\]/);
  });

  it('rejects an entry with a missing or empty id', () => {
    expect(() => validateEntries([{ path: '/a' }])).toThrow(/missing a non-empty string `id`/);
    expect(() => validateEntries([{ id: '', path: '/a' }])).toThrow(/non-empty string `id`/);
    expect(() => validateEntries([{ id: 3, path: '/a' }])).toThrow(/non-empty string `id`/);
  });

  it('rejects an entry with a missing or empty path', () => {
    expect(() => validateEntries([{ id: 'a' }])).toThrow(/\(id "a"\) is missing.*`path`/);
    expect(() => validateEntries([{ id: 'a', path: '' }])).toThrow(/`path`/);
    expect(() => validateEntries([{ id: 'a', path: 1 }])).toThrow(/`path`/);
  });

  it('rejects a duplicate plugin id', () => {
    expect(() =>
      validateEntries([
        { id: 'a', path: '/a' },
        { id: 'a', path: '/b' },
      ]),
    ).toThrow(/Duplicate plugin id "a"/);
  });

  it('accepts a valid list', () => {
    expect(() =>
      validateEntries([
        { id: 'a', path: '/a' },
        { id: 'b', path: '/b' },
      ]),
    ).not.toThrow();
  });

  it('is enforced by loadPlugins before anything is imported', async () => {
    await expect(
      loadPlugins(
        [
          { id: 'a', path: '/does/not/exist.mjs' },
          { id: 'a', path: '/x' },
        ],
        container(),
      ),
    ).rejects.toThrow(/Duplicate plugin id/);
  });
});

describe('entry matches plugin', () => {
  it('fails the boot when the entry id differs from the id of the plugin it loads', async () => {
    const path = writePlugin('mismatch', { id: 'real' });
    await expect(loadPlugins([{ id: 'claimed', path }], container())).rejects.toThrow(
      /Registry entry id "claimed" does not match the plugin's own id "real"/,
    );
    expect(order()).toEqual([]);
  });

  it('fails when the module does not default-export a valid plugin', async () => {
    const noDefault = join(dir, 'no-default.mjs');
    writeFileSync(noDefault, 'export const x = 1;\n');
    const noRegister = join(dir, 'no-register.mjs');
    writeFileSync(noRegister, "export default { id: 'a' };\n");
    await expect(loadPlugins([{ id: 'a', path: noDefault }], container())).rejects.toThrow(
      /does not default-export a valid plugin/,
    );
    await expect(loadPlugins([{ id: 'a', path: noRegister }], container())).rejects.toThrow(
      /does not default-export a valid plugin/,
    );
  });
});

describe('ports and dependencies', () => {
  it('a plugin with an unbound required port fails the boot naming the plugin and the port', async () => {
    const e = entry({ id: 'needy', requires: ['WALLET'] });
    const failure = await loadPlugins([e], container()).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('plugin "needy" requires port load-plugins.test.port.WALLET');
  });

  it('a plugin with every required port bound boots', async () => {
    const provider = entry({ id: 'provider', provides: ['WALLET'] });
    const needy = entry({ id: 'needy', requires: ['WALLET'], dependsOn: [] });
    await expect(loadPlugins([needy, provider], container())).resolves.toBeDefined();
    expect(order().sort()).toEqual(['needy', 'provider']);
  });

  it('a required port bound by a later plugin still counts', async () => {
    const needy = entry({ id: 'needy', requires: ['WALLET'] });
    const provider = entry({ id: 'provider', provides: ['WALLET'] });
    await expect(loadPlugins([needy, provider], container())).resolves.toBeDefined();
  });

  it('defers the required-port check when asked', async () => {
    const needy = entry({ id: 'needy', requires: ['WALLET'] });
    await expect(
      loadPlugins([needy], container(), { requiredPorts: 'defer' }),
    ).resolves.toBeDefined();
  });

  it('an unbound optional port is reported in a warning and does not fail', async () => {
    const e = entry({ id: 'soft', optional: ['AUDIT'] });
    await expect(loadPlugins([e], container())).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { plugin: 'soft', port: 'load-plugins.test.port.AUDIT' },
      'soft runs without load-plugins.test.port.AUDIT: skips AUDIT',
    );
  });

  it('a bound optional port is not warned about', async () => {
    const soft = entry({ id: 'soft', optional: ['AUDIT'] });
    const provider = entry({ id: 'provider', provides: ['AUDIT'] });
    await loadPlugins([soft, provider], container());
    expect(warn).not.toHaveBeenCalled();
  });

  it('a plugin depending on an unregistered plugin fails with a clear error', async () => {
    const e = entry({ id: 'child', dependsOn: ['ghost'] });
    await expect(loadPlugins([e], container())).rejects.toThrow(
      'Plugin "child" depends on "ghost" which is not registered',
    );
    expect(order()).toEqual([]);
  });

  it('a circular plugin dependency fails and names the cycle', async () => {
    const a = entry({ id: 'a', dependsOn: ['b'] });
    const b = entry({ id: 'b', dependsOn: ['c'] });
    const c = entry({ id: 'c', dependsOn: ['a'] });
    await expect(loadPlugins([a, b, c], container())).rejects.toThrow(
      'Circular plugin dependency: a -> b -> c -> a',
    );
    expect(order()).toEqual([]);
  });

  it('a plugin depending on itself is a cycle', async () => {
    const a = entry({ id: 'a', dependsOn: ['a'] });
    await expect(loadPlugins([a], container())).rejects.toThrow(
      'Circular plugin dependency: a -> a',
    );
  });

  it('plugins register after the plugins they depend on', async () => {
    const top = entry({ id: 'top', dependsOn: ['mid'] });
    const mid = entry({ id: 'mid', dependsOn: ['base'] });
    const base = entry({ id: 'base' });
    await loadPlugins([top, mid, base], container());
    expect(order()).toEqual(['base', 'mid', 'top']);
  });
});

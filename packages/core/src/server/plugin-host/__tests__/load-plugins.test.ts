import { describe, expect, it } from 'vitest';
import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../define-plugin.js';
import { assertEntryMatchesPlugin, topoSort, type PluginEntry } from '../load-plugins.js';

function plugin(id: string, dependsOn: string[] = []): Plugin<TokenCatalog> {
  return {
    id,
    dependsOn,
    register() {},
  };
}

describe('topoSort', () => {
  it('places dependencies before dependents', () => {
    const sorted = topoSort([plugin('feature', ['foundation']), plugin('foundation')]);

    expect(sorted.map(({ id }) => id)).toEqual(['foundation', 'feature']);
  });

  it('rejects an unregistered dependency', () => {
    expect(() => topoSort([plugin('feature', ['missing'])])).toThrow(
      'Plugin "feature" depends on "missing" which is not registered',
    );
  });

  it('rejects a dependency cycle', () => {
    expect(() => topoSort([plugin('a', ['b']), plugin('b', ['c']), plugin('c', ['a'])])).toThrow(
      'Circular plugin dependency: a -> b -> c -> a',
    );
  });
});

describe('assertEntryMatchesPlugin', () => {
  const entry = (id: string): PluginEntry => ({ id, path: `./${id}.js` });

  it('accepts a registry entry that resolves the same plugin id', () => {
    expect(() => assertEntryMatchesPlugin(entry('wallet'), plugin('wallet'))).not.toThrow();
  });

  it('rejects a registry entry that resolves a different plugin id', () => {
    expect(() => assertEntryMatchesPlugin(entry('wallet'), plugin('tag'))).toThrow(
      /does not match the plugin's own id "tag"/,
    );
  });
});

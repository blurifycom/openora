import { describe, expect, it } from 'vitest';
import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../define-plugin.js';
import { topoSort } from '../load-plugins.js';

const catalog = {} satisfies TokenCatalog;

function plugin(id: string, dependsOn: string[] = []): Plugin<typeof catalog> {
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

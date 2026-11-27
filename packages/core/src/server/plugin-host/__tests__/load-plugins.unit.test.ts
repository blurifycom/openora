import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from '../define-plugin.js';
import { topoSort } from '../load-plugins.js';

const plugin = (id: string, dependsOn: string[] = []): Plugin<TokenCatalog> => ({
  id,
  dependsOn,
  register: () => undefined,
});

const ids = (plugins: readonly Plugin<TokenCatalog>[]) => plugins.map((p) => p.id);

describe('topoSort', () => {
  it('returns an empty list for no plugins', () => {
    expect(topoSort([])).toEqual([]);
  });

  it('keeps the list order when nothing depends on anything', () => {
    expect(ids(topoSort([plugin('c'), plugin('a'), plugin('b')]))).toEqual(['c', 'a', 'b']);
  });

  it('puts a dependency before the plugin that needs it', () => {
    expect(ids(topoSort([plugin('wallet', ['identity']), plugin('identity')]))).toEqual([
      'identity',
      'wallet',
    ]);
  });

  it('places a diamond dependency once', () => {
    const sorted = ids(
      topoSort([
        plugin('top', ['left', 'right']),
        plugin('left', ['base']),
        plugin('right', ['base']),
        plugin('base'),
      ]),
    );
    expect(sorted).toEqual(['base', 'left', 'right', 'top']);
  });

  it.each([
    ['a self dependency', [plugin('a', ['a'])], 'a -> a'],
    ['a two cycle', [plugin('a', ['b']), plugin('b', ['a'])], 'a -> b -> a'],
    [
      'a three cycle',
      [plugin('a', ['b']), plugin('b', ['c']), plugin('c', ['a'])],
      'a -> b -> c -> a',
    ],
    [
      'a cycle below an acyclic root',
      [plugin('root', ['a']), plugin('a', ['b']), plugin('b', ['a'])],
      'root -> a -> b -> a',
    ],
  ])('refuses %s and names the path', (_name, plugins, path) => {
    expect(() => topoSort(plugins)).toThrow(`Circular plugin dependency: ${path}`);
  });

  it('refuses a dependency that is not registered', () => {
    expect(() => topoSort([plugin('wallet', ['identity'])])).toThrow(
      'Plugin "wallet" depends on "identity" which is not registered',
    );
  });

  it('orders any acyclic graph so every dependency comes first, whatever the input order', () => {
    const graph = fc.integer({ min: 1, max: 8 }).chain((size) =>
      fc.tuple(
        fc.constant(size),
        fc.array(fc.array(fc.nat({ max: size - 1 }), { maxLength: 3 }), {
          minLength: size,
          maxLength: size,
        }),
      ),
    );
    fc.assert(
      fc.property(graph, fc.nat(), ([size, deps], seed) => {
        const plugins = Array.from({ length: size }, (_, index) =>
          plugin(
            `p${index}`,
            (deps[index] ?? []).filter((dep) => dep < index).map((dep) => `p${dep}`),
          ),
        );
        const shuffled = [...plugins].sort(
          (a, b) => ((a.id.charCodeAt(1) * 31 + seed) % 7) - ((b.id.charCodeAt(1) * 31 + seed) % 7),
        );
        const sorted = topoSort(shuffled);
        expect([...ids(sorted)].sort()).toEqual([...ids(plugins)].sort());
        const position = new Map(sorted.map((p, index) => [p.id, index]));
        for (const p of sorted) {
          for (const dep of p.dependsOn ?? []) {
            expect(position.get(dep) ?? Infinity).toBeLessThan(position.get(p.id) ?? -1);
          }
        }
      }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { createToken, type TokenCatalog } from '@openora/core/contracts';
import { Container } from '../../kernel/index.js';
import { defineExtensions, definePluginWithCatalog, ModuleRegistryImpl } from '../index.js';

const COUNT = createToken<number>('COUNT');
const SEED = createToken<number>('SEED');
const OTHER = createToken<string>('OTHER');

const catalog = { COUNT, SEED } satisfies TokenCatalog;

const typedPlugin = definePluginWithCatalog<typeof catalog>()({
  id: 'typed-plugin',
  dependsOn: ['foundation'],
  register(ctx) {
    ctx.provide(COUNT, (container) => container.get(SEED) + 1);

    // @ts-expect-error A token outside the catalog is not a valid provider.
    ctx.provide(OTHER, () => 'not-registered');
  },
});

const typedPluginId: 'typed-plugin' = typedPlugin.id;
const typedDependency: readonly ['foundation'] = typedPlugin.dependsOn ?? ['foundation'];

const validGraph = defineExtensions([
  { id: 'foundation', path: './foundation.js' },
  { id: 'feature', path: './feature.js', dependsOn: ['foundation'] },
]);

// @ts-expect-error The registry must reject an unknown dependency.
defineExtensions([{ id: 'feature', path: './feature.js', dependsOn: ['missing'] }]);

// @ts-expect-error The registry must reject a dependency cycle.
defineExtensions([
  { id: 'a', path: './a.js', dependsOn: ['b'] },
  { id: 'b', path: './b.js', dependsOn: ['a'] },
]);

describe('typed plugin surface', () => {
  it('keeps literal plugin metadata and resolves catalog services', () => {
    const container = new Container<typeof catalog>();
    const registry = new ModuleRegistryImpl<typeof catalog>(container);

    container.register(SEED, () => 41);
    void typedPlugin.register(registry);

    expect(typedPluginId).toBe('typed-plugin');
    expect(typedDependency).toEqual(['foundation']);
    expect(validGraph[1]?.dependsOn).toEqual(['foundation']);
    expect(container.get(COUNT)).toBe(42);
  });
});

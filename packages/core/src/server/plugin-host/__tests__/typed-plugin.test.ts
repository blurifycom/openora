import { describe, expect, it } from 'vitest';
import { createToken, type TokenCatalog } from '@openora/core/contracts';
import { Container } from '../../kernel/index.js';
import { defineExtensions, definePluginWithCatalog, ModuleRegistryImpl } from '../index.js';

const COUNT = createToken<number>('COUNT');
const SEED = createToken<number>('SEED');
const OTHER = createToken<string>('OTHER');

const catalog = { COUNT, SEED } satisfies TokenCatalog;
const typedCatalog = { COUNT, SEED } satisfies TokenCatalog<{ COUNT: number; SEED: number }>;

void typedCatalog;

const typedCatalogWrongValue = {
  // @ts-expect-error The catalog value type must match the token value.
  COUNT: createToken<string>('COUNT'),
} satisfies TokenCatalog<{ COUNT: number }>;

void typedCatalogWrongValue;

function assertTypedContainer() {
  const typedContainer = new Container<typeof catalog>();
  const typedCount: number = typedContainer.get(COUNT);
  void typedCount;

  // @ts-expect-error A catalogued container factory must return the token value.
  typedContainer.register(COUNT, () => 'wrong-value');

  // @ts-expect-error A catalogued container cannot register an unknown token.
  typedContainer.register(OTHER, () => 'not-registered');

  // @ts-expect-error A catalogued container cannot resolve an unknown token.
  typedContainer.get(OTHER);

  // @ts-expect-error A catalogued container cannot check an unknown token.
  typedContainer.has(OTHER);
}

void assertTypedContainer;

const typedPlugin = definePluginWithCatalog<typeof catalog>()({
  id: 'typed-plugin',
  dependsOn: ['foundation'],
  register(ctx) {
    ctx.provide(COUNT, (container) => container.get(SEED) + 1);

    ctx.routers.add('typed', (container) => {
      const seed: number = container.get(SEED);
      return { seed };
    });

    // @ts-expect-error A token outside the catalog is not a valid provider.
    ctx.provide(OTHER, () => 'not-registered');
  },
});

definePluginWithCatalog<typeof catalog>()({
  id: 'invalid-typed-plugin',
  register(ctx) {
    // @ts-expect-error A provider must return the catalog token value.
    ctx.provide(COUNT, () => 'wrong-value');

    ctx.routers.add('invalid', (container) => {
      // @ts-expect-error A router can only resolve catalogued tokens.
      container.get(OTHER);

      // @ts-expect-error A router can only check catalogued tokens.
      container.has(OTHER);

      return undefined;
    });
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

  it('keeps router factories on the catalogued container view', () => {
    const container = new Container<typeof catalog>();
    const registry = new ModuleRegistryImpl<typeof catalog>(container);

    container.register(SEED, () => 7);
    typedPlugin.register(registry);

    const router = registry.routers.getAll().get('typed');
    expect(router?.(container)).toEqual({ seed: 7 });
  });
});

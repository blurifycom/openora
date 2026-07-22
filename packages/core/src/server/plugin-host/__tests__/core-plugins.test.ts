import { describe, it, expect } from 'vitest';
import { corePlugins } from '../core-plugins.js';

type LoadedPlugin = { id: string; dependsOn?: readonly string[] };

async function loadDefaults() {
  const entries = corePlugins();
  const loaded = await Promise.all(
    entries.map(async (entry) => {
      const mod = (await import(entry.path)) as { default: LoadedPlugin };
      return { entry, plugin: mod.default };
    }),
  );
  return loaded;
}

describe('corePlugins', () => {
  it('resolves every entry to an importable plugin whose id matches the entry id', async () => {
    const loaded = await loadDefaults();
    for (const { entry, plugin } of loaded) {
      expect(plugin.id, `entry ${entry.id} resolves to a definePlugin`).toBe(entry.id);
    }
  });

  it('is a self-contained dependency graph - every dependsOn is present in the set', async () => {
    const loaded = await loadDefaults();
    const present = new Set(loaded.map(({ plugin }) => plugin.id));
    const missing = loaded.flatMap(({ plugin }) =>
      (plugin.dependsOn ?? [])
        .filter((dep) => !present.has(dep))
        .map((dep) => `${plugin.id} -> ${dep}`),
    );
    expect(missing).toEqual([]);
  });
});

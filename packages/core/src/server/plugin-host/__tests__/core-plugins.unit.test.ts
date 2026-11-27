import { describe, expect, it } from 'vitest';
import { corePlugins } from '../core-plugins.js';

type LoadedPlugin = { id: string; dependsOn?: readonly string[] };

async function loadDefaults() {
  return Promise.all(
    corePlugins().map(async (entry) => {
      const mod = (await import(entry.path)) as { default: LoadedPlugin };
      return { entry, plugin: mod.default };
    }),
  );
}

describe('corePlugins', () => {
  it('resolves every entry to an importable plugin whose id matches the entry id', async () => {
    for (const { entry, plugin } of await loadDefaults()) {
      expect(plugin.id, `entry ${entry.id} resolves to a plugin`).toBe(entry.id);
    }
  }, 60000);

  it.each([
    ['the full set', []],
    ['the documented chat opt-out', ['chat', 'chat-commands', 'social']],
  ])(
    'is a self-contained dependency graph - %s',
    async (_name, optedOut: string[]) => {
      const loaded = (await loadDefaults()).filter(({ entry }) => !optedOut.includes(entry.id));
      const present = new Set(loaded.map(({ plugin }) => plugin.id));
      const missing = loaded.flatMap(({ plugin }) =>
        (plugin.dependsOn ?? [])
          .filter((dep) => !present.has(dep))
          .map((dep) => `${plugin.id} -> ${dep}`),
      );
      expect(missing).toEqual([]);
    },
    60000,
  );
});

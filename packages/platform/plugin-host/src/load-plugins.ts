import type { Plugin } from './define-plugin.js';
import { ModuleRegistryImpl } from './module-registry.js';

export interface PluginEntry {
  id: string;
  path: string;
}

function topoSort(plugins: Plugin[]): Plugin[] {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const visited = new Set<string>();
  const sorted: Plugin[] = [];

  function visit(plugin: Plugin, stack: Set<string>) {
    if (visited.has(plugin.id)) return;
    if (stack.has(plugin.id)) {
      throw new Error(`Circular plugin dependency: ${[...stack, plugin.id].join(' -> ')}`);
    }
    stack.add(plugin.id);
    for (const dep of plugin.dependsOn ?? []) {
      const depPlugin = byId.get(dep);
      if (!depPlugin)
        throw new Error(`Plugin "${plugin.id}" depends on "${dep}" which is not registered`);
      visit(depPlugin, stack);
    }
    stack.delete(plugin.id);
    visited.add(plugin.id);
    sorted.push(plugin);
  }

  for (const plugin of plugins) {
    visit(plugin, new Set());
  }

  return sorted;
}

export async function loadPlugins(entries: PluginEntry[]): Promise<ModuleRegistryImpl> {
  const plugins: Plugin[] = [];

  for (const entry of entries) {
    const mod = (await import(entry.path)) as { default?: Plugin };
    const plugin = mod.default;
    if (!plugin || typeof plugin.register !== 'function') {
      throw new Error(`Plugin at "${entry.path}" does not export a valid definePlugin result`);
    }
    plugins.push(plugin);
  }

  const ordered = topoSort(plugins);
  const registry = new ModuleRegistryImpl();

  for (const plugin of ordered) {
    await plugin.register(registry);
  }

  return registry;
}

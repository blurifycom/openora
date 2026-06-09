import type { Container } from '@oss/core';
import type { Plugin } from './define-plugin.js';
import { ModuleRegistryImpl } from './module-registry.js';

export interface PluginEntry {
  id: string;
  path: string;
  // 'module' (default) = a domain module, selectable by a service manifest.
  // 'infra' = a broker/queue driver overlay that always loads, even for a
  // single-module service, because a standalone process still needs its
  // durable transport. See applyServiceManifest.
  kind?: 'module' | 'infra';
}

/**
 * Fail fast with a precise message when extensions.config.ts is malformed, so an
 * agent that hand-edits the registry gets a structural error here instead of a deep
 * runtime stack trace later.
 */
function validateEntries(entries: unknown): asserts entries is PluginEntry[] {
  if (!Array.isArray(entries)) {
    throw new Error(
      `extensions.config.ts must export \`extensions\` as an array of { id, path }. Got ${typeof entries}.`,
    );
  }
  const seen = new Set<string>();
  entries.forEach((entry, i) => {
    const at = `extensions[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${at} must be an object { id, path }. Got ${JSON.stringify(entry)}.`);
    }
    const { id, path } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${at} is missing a non-empty string \`id\`. Got ${JSON.stringify(entry)}.`);
    }
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`${at} (id "${id}") is missing a non-empty string \`path\`.`);
    }
    if (seen.has(id)) {
      throw new Error(
        `Duplicate plugin id "${id}" in extensions.config.ts - each id must be unique.`,
      );
    }
    seen.add(id);
  });
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

export async function loadPlugins(
  entries: PluginEntry[],
  container: Container,
): Promise<ModuleRegistryImpl> {
  validateEntries(entries);
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
  const registry = new ModuleRegistryImpl(container);

  for (const plugin of ordered) {
    await plugin.register(registry);
  }

  return registry;
}

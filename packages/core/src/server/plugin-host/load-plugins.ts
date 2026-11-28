import type { Container } from '../kernel/index.js';
import { createLogger } from '../kernel/logger.js';
import type { TokenCatalog } from '@openora/core/contracts';
import type { Plugin } from './define-plugin.js';
import { ModuleRegistryImpl } from './module-registry.js';

const logger = createLogger('plugin-host');

export type PluginEntry = {
  id: string;
  path: string;
  kind?: 'module' | 'infra';
  noRoutes?: boolean;
};

export function validateEntries(entries: unknown): asserts entries is PluginEntry[] {
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

function assertEntryMatchesPlugin<C extends TokenCatalog>(
  entry: PluginEntry,
  plugin: Plugin<C>,
): void {
  if (entry.id !== plugin.id) {
    throw new Error(
      `Registry entry id "${entry.id}" does not match the plugin's own id "${plugin.id}" ` +
        `(loaded from ${entry.path}).`,
    );
  }
}

export function topoSort<C extends TokenCatalog>(plugins: Plugin<C>[]): Plugin<C>[] {
  const byId = new Map<string, Plugin<C>>(plugins.map((p) => [p.id, p]));
  const visited = new Set<string>();
  const sorted: Plugin<C>[] = [];

  function visit(plugin: Plugin<C>, stack: Set<string>) {
    if (visited.has(plugin.id)) {
      return;
    }
    if (stack.has(plugin.id)) {
      throw new Error(`Circular plugin dependency: ${[...stack, plugin.id].join(' -> ')}`);
    }
    stack.add(plugin.id);
    for (const dep of plugin.dependsOn ?? []) {
      const depPlugin = byId.get(dep);
      if (!depPlugin) {
        throw new Error(`Plugin "${plugin.id}" depends on "${dep}" which is not registered`);
      }
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

export async function importPlugin<C extends TokenCatalog>(entry: PluginEntry): Promise<Plugin<C>> {
  const mod = (await import(entry.path)) as { default?: Plugin<C> };
  const plugin = mod.default;
  if (!plugin || typeof plugin.register !== 'function') {
    throw new Error(`Plugin at "${entry.path}" does not default-export a valid plugin`);
  }
  assertEntryMatchesPlugin(entry, plugin);
  return plugin;
}

export async function loadPlugins<C extends TokenCatalog>(
  entries: PluginEntry[],
  container: Container<C>,
  { requiredPorts = 'assert' }: { requiredPorts?: 'assert' | 'defer' } = {},
): Promise<ModuleRegistryImpl<C>> {
  validateEntries(entries);
  const plugins: Plugin<C>[] = [];

  for (const entry of entries) {
    plugins.push(await importPlugin<C>(entry));
  }

  const ordered = topoSort(plugins);
  const registry = new ModuleRegistryImpl<C>(container);
  for (const entry of entries) {
    if (entry.noRoutes) {
      registry.requireOnly(entry.id);
    }
  }

  for (const plugin of ordered) {
    registry.setOwner(plugin.id);
    await plugin.register(registry);
    registry.setOwner(null);
  }

  if (requiredPorts === 'assert') {
    assertRequiredPorts(ordered, container);
  }
  for (const { plugin, port, without } of unboundOptionalPorts(ordered, container)) {
    logger.warn({ plugin, port }, `${plugin} runs without ${port}: ${without}`);
  }

  return registry;
}

export function portName(port: symbol) {
  return String(port.description ?? port);
}

function unboundOptionalPorts<C extends TokenCatalog>(
  plugins: Plugin<C>[],
  container: Container<C>,
): { plugin: string; port: string; without: string }[] {
  return plugins.flatMap((plugin) =>
    [...(plugin.optionalPorts ?? []), ...(plugin.controlPorts ?? [])]
      .filter(({ port }) => !container.has(port))
      .map(({ port, without }) => ({ plugin: plugin.id, port: portName(port), without })),
  );
}

function assertRequiredPorts<C extends TokenCatalog>(
  plugins: Plugin<C>[],
  container: Container<C>,
): void {
  const unbound = plugins.flatMap((plugin) =>
    (plugin.requiresPorts ?? [])
      .filter((token) => !container.has(token))
      .map(
        (token) => `  - plugin "${plugin.id}" requires port ${String(token.description ?? token)}`,
      ),
  );
  if (unbound.length > 0) {
    throw new Error(
      `[plugin-host] Required ports are unbound at boot:\n${unbound.join('\n')}\n` +
        `A domain reaches another domain only through a port the other domain binds. ` +
        `Load the module that binds each port (eg wallet binds WALLET_COMMANDS) - with ` +
        `SERVICE_MANIFEST set, add it to the manifest - or remove the plugin that requires it. ` +
        `See ADR-0024.`,
    );
  }
}

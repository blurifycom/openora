import type { Container } from '../kernel/index.js';
import type { Plugin } from './define-plugin.js';
import { ModuleRegistryImpl } from './module-registry.js';

export type PluginEntry = {
  id: string;
  path: string;
  // 'module' (default) = a domain module, selectable by a service manifest.
  // 'infra' = a broker/queue driver overlay that always loads, even for a
  // single-module service, because a standalone process still needs its
  // durable transport. See applyServiceManifest.
  // 'addon' = a optional, extract-later package under packages/addons/*. The
  // composition root loads it only when its id is in the OSS_ADDONS allowlist
  // (edition gate); for a service manifest it behaves like a normal module. See
  // tools/gen/build-contract.ts and ADR-0020.
  kind?: 'module' | 'infra' | 'addon';
};

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

  assertRequiredPorts(ordered, container);

  return registry;
}

/**
 * Boot-time fail-fast for cross-domain ports (ADR-0024). A domain depends ONLY on
 * the foundation and reaches another domain through a port token the other domain
 * binds - never an import. So when a domain package is left out of the install, its
 * port is simply unbound; without this check the app would boot and only blow up on
 * the first request that resolves the token, with a generic "No provider" message.
 * Here we verify every declared `requiresPorts` token is bound right after
 * registration and throw one actionable error naming the plugin, the port, and the
 * likely-missing package.
 */
export function assertRequiredPorts(plugins: Plugin[], container: Container): void {
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
        `Install the package that provides each port (eg @blurifycom/wallet binds WALLET_COMMANDS) ` +
        `or remove the plugin that requires it. See ADR-0024.`,
    );
  }
}

import { resolve, dirname, isAbsolute } from 'node:path';
import { accessSync } from 'node:fs';
import type { PluginEntry } from './load-plugins.js';

/**
 * Load the extensions.config.ts registry from disk and resolve plugin paths.
 * Resolves via EXTENSIONS_CONFIG env var or walks up from process.cwd().
 * Optional `filter` lets a composition root drop entries. `SERVICE_MANIFEST` is
 * applied by `createApp`, to this list or any other it is given.
 */
export async function loadExtensions(
  filter?: (entries: PluginEntry[]) => PluginEntry[],
): Promise<PluginEntry[]> {
  const fromEnv = process.env['EXTENSIONS_CONFIG'];
  const configPath = fromEnv
    ? isAbsolute(fromEnv)
      ? fromEnv
      : resolve(process.cwd(), fromEnv)
    : findConfigUpwards(process.cwd());

  const mod = (await import(configPath)) as { extensions: PluginEntry[] };
  const configDir = dirname(configPath);

  const resolved = mod.extensions.map((entry) => ({
    ...entry,
    path: isAbsolute(entry.path) ? entry.path : resolve(configDir, entry.path),
  }));

  return filter ? filter(resolved) : resolved;
}

function findConfigUpwards(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    for (const ext of ['.js', '.ts']) {
      const candidate = resolve(dir, `extensions.config${ext}`);
      try {
        accessSync(candidate);
        return candidate;
      } catch {
        // not here - try parent
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    `extensions.config.js not found above ${start}. ` +
      `Set EXTENSIONS_CONFIG to point at it explicitly.`,
  );
}

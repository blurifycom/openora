import type { PluginEntry } from '@oss/plugin-host';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync } from 'node:fs';

// Loads extensions.config.js (compiled) from the workspace root at runtime.
//
// Resolution order:
//   1. EXTENSIONS_CONFIG env var (absolute path, or path relative to cwd)
//   2. Walk up from this file's location looking for extensions.config.js
//
// In dev, tsx resolves .js -> .ts. In Docker builds, extensions.config.ts is
// pre-compiled to extensions.config.js by api.Dockerfile.
export async function loadExtensions(): Promise<PluginEntry[]> {
  const fromEnv = process.env['EXTENSIONS_CONFIG'];
  const configPath = fromEnv
    ? isAbsolute(fromEnv)
      ? fromEnv
      : resolve(process.cwd(), fromEnv)
    : findConfigUpwards(dirname(fileURLToPath(import.meta.url)));

  const mod = (await import(configPath)) as { extensions: PluginEntry[] };
  const configDir = dirname(configPath);

  // Plugin entries use paths relative to the config file (typically the
  // workspace root), so resolve against the config's directory.
  return mod.extensions.map((entry) => ({
    ...entry,
    path: isAbsolute(entry.path) ? entry.path : resolve(configDir, entry.path),
  }));
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
        // not here
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `extensions.config.js not found above ${start}. ` +
      `Set EXTENSIONS_CONFIG to point at it explicitly.`,
  );
}

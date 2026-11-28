import { resolve, dirname, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import type { PluginEntry } from './load-plugins.js';

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
      if (existsSync(candidate)) {
        return candidate;
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

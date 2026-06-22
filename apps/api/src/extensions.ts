import {
  applyServiceManifest,
  parseServiceManifest,
  type PluginEntry,
} from '@blurifycom/core/server';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync } from 'node:fs';
import { applyEdition } from './editions.js';

// Resolution order: EXTENSIONS_CONFIG env var, then walk up looking for extensions.config.js.
// In dev, tsx resolves .js -> .ts; in Docker it is pre-compiled by api.Dockerfile.
export async function loadExtensions(): Promise<PluginEntry[]> {
  const fromEnv = process.env['EXTENSIONS_CONFIG'];
  const configPath = fromEnv
    ? isAbsolute(fromEnv)
      ? fromEnv
      : resolve(process.cwd(), fromEnv)
    : findConfigUpwards(dirname(fileURLToPath(import.meta.url)));

  const mod = (await import(configPath)) as { extensions: PluginEntry[] };
  const configDir = dirname(configPath);

  const resolved = mod.extensions.map((entry) => ({
    ...entry,
    path: isAbsolute(entry.path) ? entry.path : resolve(configDir, entry.path),
  }));

  const entries = applyEdition(resolved);

  const manifest = parseServiceManifest(process.env['SERVICE_MANIFEST']);
  const selected = applyServiceManifest(entries, manifest);
  if (manifest !== null) {
    process.stdout.write(
      `SERVICE_MANIFEST active: booting ${selected.map((e) => e.id).join(', ')}\n`,
    );
  }
  return selected;
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

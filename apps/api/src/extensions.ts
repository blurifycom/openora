import { applyServiceManifest, parseServiceManifest, type PluginEntry } from '@oss/plugin-host';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync } from 'node:fs';
import { applyEdition } from './editions.js';

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
  const resolved = mod.extensions.map((entry) => ({
    ...entry,
    path: isAbsolute(entry.path) ? entry.path : resolve(configDir, entry.path),
  }));

  // Edition gate: drop premium (kind:'premium') entries this edition does not
  // enable (OSS_PREMIUM). Free edition = no premium entries load. See editions.ts.
  const entries = applyEdition(resolved);

  // Deployable-topology seam: SERVICE_MANIFEST selects which modules this process
  // boots. Unset -> the full monolith. A subset (eg "identity,wallet") boots a
  // single-purpose service from the same codebase; infra overlays always load.
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

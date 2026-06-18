import type { PluginEntry } from './load-plugins.js';

export function parseServiceManifest(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

export function applyServiceManifest(
  entries: PluginEntry[],
  manifest: readonly string[] | null,
): PluginEntry[] {
  if (manifest === null) return entries;

  const known = new Set(entries.map((e) => e.id));
  const unknown = manifest.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `SERVICE_MANIFEST names unknown module id(s): ${unknown.join(', ')}. ` +
        `Known ids: ${[...known].join(', ')}.`,
    );
  }

  const wanted = new Set(manifest);
  return entries.filter((e) => e.kind === 'infra' || wanted.has(e.id));
}

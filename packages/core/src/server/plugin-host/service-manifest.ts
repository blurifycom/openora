import { validateEntries, type PluginEntry } from './load-plugins.js';

export function parseServiceManifest(raw: string | undefined): string[] | null {
  if (raw === undefined) {
    return null;
  }
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
  if (manifest === null) {
    return entries;
  }

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

/** Reads the `dependsOn` of the plugin an entry names. */
export type DependsOnReader = (entry: PluginEntry) => Promise<readonly string[]>;

/**
 * The entries a process boots: all of them without a manifest, otherwise the manifest's modules
 * plus every infra overlay. A manifest that leaves out a module the selected ones depend on -
 * directly or through another left-out module - fails with one error that names them all, so a
 * split is fixed in one edit rather than one boot per missing module. Only the selected entries
 * are read on the way to success; a left-out one is read only to follow its own dependencies.
 */
export async function selectServiceEntries(
  entries: PluginEntry[],
  manifest: readonly string[] | null,
  dependsOnOf: DependsOnReader,
): Promise<PluginEntry[]> {
  if (manifest === null) {
    return entries;
  }
  validateEntries(entries);
  const selected = applyServiceManifest(entries, manifest);

  const selectedIds = new Set(selected.map((e) => e.id));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const missing = new Map<string, string[]>();
  const toRead = [...selected];
  // Grows while it is walked: a left-out dependency is read for its own dependencies.
  for (const entry of toRead) {
    for (const dep of await dependsOnOf(entry)) {
      if (selectedIds.has(dep)) {
        continue;
      }
      const requiredBy = missing.get(dep);
      if (requiredBy) {
        requiredBy.push(entry.id);
        continue;
      }
      missing.set(dep, [entry.id]);
      const left = byId.get(dep);
      if (left) {
        toRead.push(left);
      }
    }
  }
  if (missing.size === 0) {
    return selected;
  }

  const lines = [...missing].map(([id, requiredBy]) =>
    byId.has(id)
      ? `  - ${id} (required by ${requiredBy.join(', ')})`
      : `  - ${id} (required by ${requiredBy.join(', ')}) - not in the plugin list either`,
  );
  const addable = [...missing.keys()].filter((id) => byId.has(id));
  throw new Error(
    `SERVICE_MANIFEST=${manifest.join(',')} leaves out modules the selected ones depend on:\n` +
      `${lines.join('\n')}\n` +
      (addable.length > 0
        ? `Add them: SERVICE_MANIFEST=${[...manifest, ...addable].join(',')}\n`
        : '') +
      'A process also needs the module that binds each port its modules require.',
  );
}

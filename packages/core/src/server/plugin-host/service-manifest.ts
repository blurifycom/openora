import type { PluginEntry } from './load-plugins.js';

// A service manifest selects WHICH modules a process boots. The same codebase
// runs as the full monolith (no manifest) or as a single-purpose service (a
// subset) - the deployable-topology seam. "Exclude a module from the monolith"
// is just dropping its id from the monolith's manifest and booting it in its own
// host with a manifest of one.
//
// Infra overlays (kind: 'infra' - the broker/queue drivers) ALWAYS load, since a
// standalone service still needs its durable transport. Module entries are kept
// only when their id is in the manifest.

// Parse the SERVICE_MANIFEST env value into a list of module ids. Comma- or
// whitespace-separated. `undefined` or empty -> null, meaning "load everything"
// (the monolith default).
export function parseServiceManifest(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

// Filter plugin entries to the manifest. `manifest === null` returns every entry
// (monolith). Otherwise keep all infra overlays plus the modules named in the
// manifest. Throws on an unknown id so a typo fails fast at boot rather than
// silently shipping a service that is missing a module.
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

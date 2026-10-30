import type { PluginEntry } from './load-plugins.js';

// `identity:no-routes` loads the module for its ports, events and jobs but mounts none of
// its routers. It is for a module a kept module `dependsOn` without wanting its HTTP surface.
const NO_ROUTES_FLAG = 'no-routes';

export type ServiceManifestEntry = { id: string; noRoutes: boolean };

export function parseServiceManifest(raw: string | undefined): ServiceManifestEntry[] | null {
  if (raw === undefined) {
    return null;
  }
  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const byId = new Map<string, ServiceManifestEntry>();
  for (const token of tokens) {
    const [id = '', flag, ...rest] = token.split(':');
    if (rest.length > 0 || (flag !== undefined && flag !== NO_ROUTES_FLAG)) {
      throw new Error(
        `SERVICE_MANIFEST entry "${token}" has an unknown flag. The only flag is ":${NO_ROUTES_FLAG}".`,
      );
    }
    const noRoutes = flag === NO_ROUTES_FLAG;
    const seen = byId.get(id);
    if (seen && seen.noRoutes !== noRoutes) {
      throw new Error(`SERVICE_MANIFEST names "${id}" both with and without ":${NO_ROUTES_FLAG}".`);
    }
    byId.set(id, { id, noRoutes });
  }
  return [...byId.values()];
}

export function applyServiceManifest(
  entries: PluginEntry[],
  manifest: readonly ServiceManifestEntry[] | null,
): PluginEntry[] {
  if (manifest === null) {
    return entries;
  }

  const known = new Set(entries.map((e) => e.id));
  const unknown = manifest.filter((m) => !known.has(m.id)).map((m) => m.id);
  if (unknown.length > 0) {
    throw new Error(
      `SERVICE_MANIFEST names unknown module id(s): ${unknown.join(', ')}. ` +
        `Known ids: ${[...known].join(', ')}.`,
    );
  }

  const infraFlagged = manifest
    .filter((m) => m.noRoutes && entries.find((e) => e.id === m.id)?.kind === 'infra')
    .map((m) => m.id);
  if (infraFlagged.length > 0) {
    throw new Error(
      `SERVICE_MANIFEST marks infra overlay(s) ":${NO_ROUTES_FLAG}": ${infraFlagged.join(', ')}. ` +
        `Infra overlays always load and the flag only applies to domain modules.`,
    );
  }

  const flags = new Map(manifest.map((m) => [m.id, m.noRoutes]));
  return entries
    .filter((e) => e.kind === 'infra' || flags.has(e.id))
    .map((e) => (flags.get(e.id) ? { ...e, noRoutes: true } : e));
}

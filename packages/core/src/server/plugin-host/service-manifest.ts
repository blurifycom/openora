import { validateEntries, type PluginEntry, type UnboundControl } from './load-plugins.js';

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

/** Reads the ids of the modules that the plugin an entry names needs beside it. */
export type DependsOnReader = (entry: PluginEntry) => Promise<readonly string[]>;

/**
 * Every module that `start` needs, directly or through another, and that `selectedIds` leaves
 * out, each with the ids that need it. A left-out module the plugin list has is read for its own
 * needs; one it lacks is only named.
 */
async function leftOut(
  start: readonly PluginEntry[],
  selectedIds: ReadonlySet<string>,
  byId: ReadonlyMap<string, PluginEntry>,
  needsOf: DependsOnReader,
): Promise<Map<string, string[]>> {
  const missing = new Map<string, string[]>();
  const toRead = [...start];
  // Grows while it is walked: a left-out module is read for its own needs.
  for (const entry of toRead) {
    for (const dep of await needsOf(entry)) {
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
  return missing;
}

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

  const byId = new Map(entries.map((e) => [e.id, e]));
  const missing = await leftOut(selected, new Set(selected.map((e) => e.id)), byId, dependsOnOf);
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

/**
 * The unbound controls a manifest boot refuses, and the modules that bind them which it leaves
 * out. Only a control whose module the plugin list has is refused: that module then runs in
 * another process of the same install, which enforces the control, so this process would let
 * through what that one refuses. A list without the module has the control nowhere, and the
 * boot goes on as a full one would.
 */
function refusedControls(
  entries: readonly PluginEntry[],
  manifest: readonly string[],
  unbound: readonly UnboundControl[],
) {
  const listed = new Set(entries.map((e) => e.id));
  const refused = unbound.filter(({ boundBy }) => listed.has(boundBy));
  const selectedIds = new Set(applyServiceManifest([...entries], manifest).map((e) => e.id));
  const binders = [...new Set(refused.map(({ boundBy }) => boundBy))].filter(
    (id) => !selectedIds.has(id),
  );
  return { refused, binders, selectedIds };
}

function controlsError(
  manifest: readonly string[],
  subject: string,
  refused: readonly UnboundControl[],
  add: readonly string[],
) {
  const lines = refused.map(
    ({ owner, port, without, boundBy }) =>
      `  - ${owner} runs without ${port} (bound by ${boundBy}): ${without}`,
  );
  return new Error(
    `SERVICE_MANIFEST=${manifest.join(',')} ${subject}:\n` +
      `${lines.join('\n')}\n` +
      (add.length > 0 ? `Add them: SERVICE_MANIFEST=${[...manifest, ...add].join(',')}\n` : '') +
      'A split service may not skip a control the rest of its install enforces: load the ' +
      'module that binds each port, or bind the port in an overlay.',
  );
}

/**
 * Fails a SERVICE_MANIFEST boot on an unbound control whose module the plugin list has, naming
 * the owner, the port, what the owner skips and the module that binds it. `subject` says what
 * the controls guard, after the manifest: "serves admin routes without ...".
 */
export function assertControlsBound(
  entries: readonly PluginEntry[],
  manifest: readonly string[],
  subject: string,
  unbound: readonly UnboundControl[],
): void {
  const { refused, binders } = refusedControls(entries, manifest, unbound);
  if (refused.length > 0) {
    throw controlsError(manifest, subject, refused, binders);
  }
}

/**
 * `assertControlsBound` for the selected modules' `controlPorts`. Its manifest line also adds
 * every module the binding ones need in turn, as `needsOf` reads it, so a split is fixed in one
 * edit, as with a missing dependency.
 */
export async function assertModuleControlsBound(
  entries: PluginEntry[],
  manifest: readonly string[],
  unbound: readonly UnboundControl[],
  needsOf: DependsOnReader,
): Promise<void> {
  const { refused, binders, selectedIds } = refusedControls(entries, manifest, unbound);
  if (refused.length === 0) {
    return;
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  const needed = await leftOut(
    binders.flatMap((id) => byId.get(id) ?? []),
    new Set([...selectedIds, ...binders]),
    byId,
    needsOf,
  );
  throw controlsError(
    manifest,
    'leaves unbound controls the rest of the install enforces',
    refused,
    [...binders, ...[...needed.keys()].filter((id) => byId.has(id))],
  );
}

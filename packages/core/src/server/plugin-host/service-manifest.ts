import type { TokenCatalog } from '@openora/core/contracts';
import { Container } from '../kernel/index.js';
import type { ControlPort, Plugin } from './define-plugin.js';
import { portName, validateEntries, type PluginEntry } from './load-plugins.js';
import { ModuleRegistryImpl } from './module-registry.js';

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

/** A control the host process holds a manifest boot to, beside its plugins' `controlPorts`. */
export type HostControl<C extends TokenCatalog> = ControlPort<C> & {
  /** What runs without the port, as the boot error names it. */
  owner: string;
};

/** What a SERVICE_MANIFEST boot is checked against. */
export type ServiceManifestCheck<C extends TokenCatalog> = {
  /** The whole plugin list: the manifest's modules and every one it leaves out. */
  entries: readonly PluginEntry[];
  manifest: readonly string[];
  readPlugin: (entry: PluginEntry) => Promise<Plugin<C>>;
  hostControls: readonly HostControl<C>[];
  /** Whether the process has bound the port so far. */
  isBound: (port: C[keyof C]) => boolean;
};

type MissingModule = { kind: 'module'; id: string; requiredBy: string[]; listed: boolean };

type Finding =
  | MissingModule
  | { kind: 'required'; owner: string; port: string; boundBy: string | undefined }
  | { kind: 'control'; owner: string; port: string; boundBy: string; without: string };

function findingLine(finding: Finding) {
  switch (finding.kind) {
    case 'module':
      return finding.listed
        ? `  - ${finding.id} (required by ${finding.requiredBy.join(', ')})`
        : `  - ${finding.id} (required by ${finding.requiredBy.join(', ')}) - not in the plugin list either`;
    case 'required':
      return finding.boundBy === undefined
        ? `  - ${finding.owner} requires ${finding.port}, which no module in the plugin list binds`
        : `  - ${finding.owner} requires ${finding.port} (bound by ${finding.boundBy})`;
    case 'control':
      return `  - ${finding.owner} runs without ${finding.port} (bound by ${finding.boundBy}): ${finding.without}`;
  }
}

/**
 * The modules that bind each of `ports`, in plugin-list order. Each plugin registers into a
 * container of its own, so a later binding hides no earlier one. A plugin whose registration
 * throws - a module this process does not load may lack its configuration - counts with what it
 * bound before the throw, and is listed in `failed` with the error.
 */
async function portBinders<C extends TokenCatalog>(
  plugins: readonly Plugin<C>[],
  ports: readonly C[keyof C][],
) {
  const binders = new Map<symbol, string[]>();
  const failed: string[] = [];
  for (const plugin of plugins) {
    const container = new Container<C>();
    const registry = new ModuleRegistryImpl<C>(container);
    registry.setOwner(plugin.id);
    try {
      await plugin.register(registry);
    } catch (err) {
      failed.push(`  - ${plugin.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const port of ports.filter((p) => container.has(p))) {
      binders.set(port, [...(binders.get(port) ?? []), plugin.id]);
    }
  }
  return { binders, failed };
}

/**
 * Everything the manifest leaves out. From the selected modules it follows each `dependsOn`,
 * the module that binds each required port nothing bound, and the module behind each unbound
 * control the plugin list has - the host's controls included - then does the same for every
 * module that adds, until nothing new is needed. `added` is what to append to the manifest.
 */
function shortfall<C extends TokenCatalog>(
  check: ServiceManifestCheck<C>,
  plugins: ReadonlyMap<string, Plugin<C>>,
  binders: ReadonlyMap<symbol, readonly string[]>,
) {
  const selected = new Set(
    applyServiceManifest([...check.entries], check.manifest).map((e) => e.id),
  );
  const loaded = new Set(selected);
  const added: string[] = [];
  const findings: Finding[] = [];
  const missing = new Map<string, MissingModule>();

  const load = (id: string) => {
    if (plugins.has(id) && !loaded.has(id)) {
      loaded.add(id);
      added.push(id);
    }
  };
  const bound = (port: C[keyof C]) =>
    check.isBound(port) || (binders.get(port) ?? []).some((id) => loaded.has(id));
  const requireModule = (id: string, by: string) => {
    const known = missing.get(id);
    if (known) {
      known.requiredBy.push(by);
      return;
    }
    const finding: MissingModule = {
      kind: 'module',
      id,
      requiredBy: [by],
      listed: plugins.has(id),
    };
    missing.set(id, finding);
    findings.push(finding);
    load(id);
  };
  const requirePort = (owner: string, port: C[keyof C]) => {
    if (bound(port)) {
      return;
    }
    const boundBy = binders.get(port)?.at(-1);
    findings.push({ kind: 'required', owner, port: portName(port), boundBy });
    if (boundBy !== undefined) {
      load(boundBy);
    }
  };
  const requireControl = (owner: string, { port, without, boundBy }: ControlPort<C>) => {
    if (bound(port) || !plugins.has(boundBy)) {
      return;
    }
    findings.push({ kind: 'control', owner, port: portName(port), boundBy, without });
    load(boundBy);
  };

  const dependenciesRead = new Set<string>();
  const portsRead = new Set<string>();
  let hostRead = false;
  for (;;) {
    // A Set's iterator also visits what is added while it runs, so this closes over dependsOn.
    for (const id of loaded) {
      if (dependenciesRead.has(id)) {
        continue;
      }
      dependenciesRead.add(id);
      for (const dep of plugins.get(id)?.dependsOn ?? []) {
        if (!selected.has(dep)) {
          requireModule(dep, id);
        }
      }
    }
    const unread = [...loaded].filter((id) => !portsRead.has(id));
    if (unread.length === 0 && hostRead) {
      return { findings, added };
    }
    for (const id of unread) {
      portsRead.add(id);
      const plugin = plugins.get(id);
      for (const port of plugin?.requiresPorts ?? []) {
        requirePort(id, port);
      }
      for (const control of plugin?.controlPorts ?? []) {
        requireControl(id, control);
      }
    }
    if (!hostRead) {
      hostRead = true;
      for (const control of check.hostControls) {
        requireControl(control.owner, control);
      }
    }
  }
}

/**
 * The one error a manifest boot fails with: every module the manifest leaves out and why, and a
 * manifest line that adds them all, so one edit fixes it. Reads and registers every plugin in
 * the list, each on its own, to learn which module binds which port.
 */
async function shortfallError<C extends TokenCatalog>(check: ServiceManifestCheck<C>) {
  const plugins = new Map<string, Plugin<C>>();
  for (const entry of check.entries) {
    plugins.set(entry.id, await check.readPlugin(entry));
  }
  const ports = [
    ...[...plugins.values()].flatMap((plugin) => [
      ...(plugin.requiresPorts ?? []),
      ...(plugin.controlPorts ?? []).map(({ port }) => port),
    ]),
    ...check.hostControls.map(({ port }) => port),
  ];
  const { binders, failed } = await portBinders([...plugins.values()], ports);
  const { findings, added } = shortfall(check, plugins, binders);
  const manifest = check.manifest.join(',');
  const unknownBinder = findings.some((f) => f.kind === 'required' && f.boundBy === undefined);
  return new Error(
    `SERVICE_MANIFEST=${manifest} leaves out what this service needs:\n` +
      `${findings.map(findingLine).join('\n')}\n` +
      (added.length > 0 ? `Add them: SERVICE_MANIFEST=${[manifest, ...added].join(',')}\n` : '') +
      (findings.some(({ kind }) => kind === 'control')
        ? 'A split service may not skip a control the rest of its install enforces: load the ' +
          'module that binds each port, or bind the port in an overlay.'
        : 'A split service loads every module its modules depend on and every module that ' +
          'binds a port they require.') +
      (unknownBinder && failed.length > 0
        ? `\nThese modules failed to register, so the ports they bind are unknown:\n${failed.join('\n')}`
        : ''),
  );
}

/**
 * The entries a manifest boot loads: the manifest's modules plus every infra overlay. A
 * manifest that leaves out a module they depend on fails before anything registers, with the
 * error `assertServiceComplete` gives. Only the selected entries are read on the way to success.
 */
export async function selectServiceEntries<C extends TokenCatalog>(check: ServiceManifestCheck<C>) {
  validateEntries(check.entries);
  const selected = applyServiceManifest([...check.entries], check.manifest);
  const ids = new Set(selected.map((e) => e.id));
  for (const entry of selected) {
    const { dependsOn = [] } = await check.readPlugin(entry);
    if (dependsOn.some((dep) => !ids.has(dep))) {
      throw await shortfallError(check);
    }
  }
  return selected;
}

/**
 * Fails a manifest boot, once its modules registered and the composition root bound its own
 * ports, while a selected module's required port is unbound, or a control - a selected module's
 * `controlPorts` entry or one of the host's - is unbound and the plugin list has the module
 * that binds it. That module then runs in another process of the same install, which enforces
 * the control, so this one would let through what that one refuses. A list without the module
 * has the control nowhere, and the boot goes on as a full one would. The error names everything
 * the manifest leaves out, with a manifest line that boots.
 */
export async function assertServiceComplete<C extends TokenCatalog>(
  check: ServiceManifestCheck<C>,
) {
  const listed = new Set(check.entries.map((e) => e.id));
  const selected = await Promise.all(
    applyServiceManifest([...check.entries], check.manifest).map((e) => check.readPlugin(e)),
  );
  const controls = [
    ...selected.flatMap((plugin) => plugin.controlPorts ?? []),
    ...check.hostControls,
  ];
  const refused =
    selected.some((plugin) => (plugin.requiresPorts ?? []).some((port) => !check.isBound(port))) ||
    controls.some(({ port, boundBy }) => !check.isBound(port) && listed.has(boundBy));
  if (refused) {
    throw await shortfallError(check);
  }
}

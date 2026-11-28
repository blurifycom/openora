import type { TokenCatalog } from '@openora/core/contracts';
import { Container } from '../kernel/index.js';
import type { ControlPort, Plugin } from './define-plugin.js';
import { portName, validateEntries, type PluginEntry } from './load-plugins.js';
import { ModuleRegistryImpl } from './module-registry.js';

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

export type HostControl<C extends TokenCatalog> = ControlPort<C> & {
  owner: string;
};

export type ServiceManifestCheck<C extends TokenCatalog> = {
  entries: readonly PluginEntry[];
  manifest: readonly ServiceManifestEntry[];
  readPlugin: (entry: PluginEntry) => Promise<Plugin<C>>;
  hostControls: readonly HostControl<C>[];
  isBound: (port: C[keyof C]) => boolean;
  registered?: ReadonlySet<string>;
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

function shortfall<C extends TokenCatalog>(
  check: ServiceManifestCheck<C>,
  plugins: ReadonlyMap<string, Plugin<C>>,
  binders: ReadonlyMap<symbol, readonly string[]>,
) {
  const selectedEntries = applyServiceManifest([...check.entries], check.manifest);
  const selected = new Set(selectedEntries.map((e) => e.id));
  const routeless = new Set(selectedEntries.filter((e) => e.noRoutes).map((e) => e.id));
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
        if (!(control.routesOnly && routeless.has(id))) {
          requireControl(id, control);
        }
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
  const unregistered = [...plugins.values()].filter(({ id }) => !check.registered?.has(id));
  const { binders, failed } = await portBinders(unregistered, ports);
  const { findings, added } = shortfall(check, plugins, binders);
  const manifest = check.manifest
    .map((m) => (m.noRoutes ? `${m.id}:${NO_ROUTES_FLAG}` : m.id))
    .join(',');
  const unknownBinder = findings.some((f) => f.kind === 'required' && f.boundBy === undefined);
  return new Error(
    `SERVICE_MANIFEST=${manifest} leaves out what this service needs:\n` +
      `${findings.map(findingLine).join('\n')}\n` +
      (added.length > 0
        ? `Add them: SERVICE_MANIFEST=${[manifest, ...added.map((id) => `${id}:${NO_ROUTES_FLAG}`)].join(',')}\n`
        : '') +
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

export async function assertServiceComplete<C extends TokenCatalog>(
  check: ServiceManifestCheck<C>,
) {
  const listed = new Set(check.entries.map((e) => e.id));
  const entries = applyServiceManifest([...check.entries], check.manifest);
  const selected = await Promise.all(entries.map((e) => check.readPlugin(e)));
  const controls = [
    ...selected.flatMap((plugin, i) =>
      (plugin.controlPorts ?? []).filter((c) => !(c.routesOnly && entries[i]?.noRoutes)),
    ),
    ...check.hostControls,
  ];
  const refused =
    selected.some((plugin) => (plugin.requiresPorts ?? []).some((port) => !check.isBound(port))) ||
    controls.some(({ port, boundBy }) => !check.isBound(port) && listed.has(boundBy));
  if (refused) {
    throw await shortfallError(check);
  }
}

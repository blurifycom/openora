#!/usr/bin/env node
/**
 * Generates the platform CATALOG - the machine-readable surface a downstream
 * consumer's AI agent reads INSTEAD of grepping node_modules. Emits:
 *   docs/catalog.json  - structured, consumed at runtime by the published @openora/mcp
 *                        server (a consumer's node_modules has no platform source).
 * Human/agent-readable access is the MCP dev server (describe-module, list-routes,
 * query-openapi) and each module's AGENTS.md - no monolithic markdown dump.
 *
 * It captures: modules (+ tables + routes), adapter seams (+ wired-vs-stub
 * status), domain events, UI slots, Zod schema index, the igaming-config shape,
 * and the plugin-contract surface.
 *
 * Pure filesystem parsing - no package imports - so it is robust and DETERMINISTIC
 * (no timestamp), which lets CI run it and fail on an uncommitted diff (drift gate).
 *
 * Run via `pnpm regen` (or `pnpm gen:catalog`).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const addonsRoot = join(repoRoot, 'packages', 'addons');

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

type ModuleSrc = { id: string; srcDir: string };
function moduleSrcDirs(): ModuleSrc[] {
  const out: ModuleSrc[] = [];
  const hasPlugin = (srcDir: string): boolean => existsSync(join(srcDir, 'plugin.ts'));
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (existsSync(addonsRoot)) {
    for (const name of readdirSync(addonsRoot)) {
      const srcDir = join(addonsRoot, name, 'src');
      if (isDir(join(addonsRoot, name)) && hasPlugin(srcDir)) out.push({ id: name, srcDir });
    }
  }
  // Domains fold into @openora/core as subpaths. See ADR-0024/0025.
  const coreSrc = join(repoRoot, 'packages', 'core', 'src');
  const engineDirs = new Set(['contracts', 'server', 'react']);
  if (existsSync(coreSrc)) {
    for (const d of readdirSync(coreSrc)) {
      const dsrc = join(coreSrc, d);
      if (!isDir(dsrc) || engineDirs.has(d)) continue;
      if (hasPlugin(dsrc)) {
        out.push({ id: d, srcDir: dsrc }); // single-member domain (incl. compliance)
      } else {
        for (const member of readdirSync(dsrc)) {
          const msrc = join(dsrc, member);
          if (isDir(msrc) && hasPlugin(msrc)) out.push({ id: member, srcDir: msrc });
        }
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e.startsWith('node_modules') || ['dist', '.next', '.turbo', 'coverage'].includes(e))
      continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // skip broken symlinks / vanished entries
    }
    if (st.isDirectory()) walk(full, ext, acc);
    else if (full.endsWith(ext)) acc.push(full);
  }
  return acc;
}

type ModuleInfo = { id: string; group: string; tables: string[]; routes: string[] };

function readAddonKinds(): Map<string, string> {
  const src = read(join(repoRoot, 'extensions.config.ts'));
  const out = new Map<string, string>();
  for (const m of src.matchAll(/\{[^}]*id:\s*'([^']+)'[^}]*\}/g)) {
    const entry = m[0] ?? '';
    const id = m[1] ?? '';
    out.set(id, /kind:\s*'addon'/.test(entry) ? 'addon' : 'core');
  }
  return out;
}

function collectModules(): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  const kinds = readAddonKinds();
  for (const { id, srcDir } of moduleSrcDirs()) {
    const schema = read(join(srcDir, 'schema', 'index.ts'));
    const router = read(join(srcDir, 'router', 'index.ts'));
    const tables = [...schema.matchAll(/pgTable\(\s*'([^']+)'/g)].map((m) => m[1] ?? '').sort();
    const routes = [...router.matchAll(/^\s{2,}(\w+):\s*os\b/gm)]
      .map((m) => `${id}.${m[1]}`)
      .sort();
    out.push({ id, group: kinds.get(id) ?? 'core', tables, routes });
  }
  return out;
}

type AdapterInfo = {
  category: string;
  interface: string;
  token: string;
  status: 'wired' | 'stub';
  boundIn: string[];
};

function collectAdapters(): AdapterInfo[] {
  const dir = join(repoRoot, 'packages', 'core', 'src', 'contracts', 'adapters');
  // Scan add-on packages plus the engine app factory, so platform-level default
  // bindings (eg the in-process MESSAGE_BROKER seeded in create-app) count as wired.
  const moduleFiles = [
    ...moduleSrcDirs().flatMap(({ srcDir }) => walk(srcDir, '.ts')),
    ...walk(join(repoRoot, 'packages', 'core', 'src', 'server', 'runtime'), '.ts'),
  ];
  const moduleSrc = moduleFiles.map((f) => ({ f, src: readFileSync(f, 'utf8') }));
  const out: AdapterInfo[] = [];
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file === 'index.ts') continue;
    const src = readFileSync(join(dir, file), 'utf8');
    const iface =
      src.match(/export (?:interface|type) (\w*Adapter)\b/)?.[1] ??
      src.match(/export (?:interface|type) (\w+)/)?.[1] ??
      '';
    const token =
      src.match(
        /export const (\w+)(?::\s*(?:Sealed)?Token<[^>]*>)?\s*=\s*(?:createSealedToken|createToken|Symbol)/,
      )?.[1] ?? '';
    if (!token) continue;
    const boundIn = moduleSrc
      .filter(({ src }) =>
        new RegExp(
          `(provideSealed\\(\\s*${token}\\b|provide\\(\\s*${token}\\b|provide:\\s*${token}\\b|\\.get\\(\\s*${token}\\b|@Inject\\(\\s*${token}\\s*\\))`,
        ).test(src),
      )
      .map(({ f }) => f.replace(`${repoRoot}/`, ''))
      .sort();
    out.push({
      category: file.replace(/\.ts$/, ''),
      interface: iface,
      token,
      status: boundIn.length > 0 ? 'wired' : 'stub',
      boundIn,
    });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category));
}

function collectEvents(): string[] {
  const set = new Set<string>();
  for (const { srcDir } of moduleSrcDirs()) {
    for (const f of walk(srcDir, '.ts')) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\.emit\(\s*'([a-z][\w.:-]+)'/g))
        set.add(m[1] ?? '');
    }
  }
  return [...set].sort();
}

function collectSlots(): Array<{ name: string; description: string }> {
  const file = join(repoRoot, 'packages', 'sdks', 'react-sdk', 'src', 'ui-plugin', 'slots.ts');
  const src = read(file);
  const out: Array<{ name: string; description: string }> = [];
  let pending = '';
  for (const line of src.split('\n')) {
    const jsdoc = line.match(/\/\*\*\s*(.+?)\s*\*\//);
    if (jsdoc) {
      pending = (jsdoc[1] ?? '').trim();
      continue;
    }
    const slot = line.match(/:\s*'([a-z][a-z:]+)'/);
    if (slot) {
      out.push({ name: slot[1] ?? '', description: pending });
      pending = '';
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Each add-on owns its route contract under src/contract, so the schema index spans both the cross-cutting contracts packages and every add-on contract dir. See ADR-0021.
function collectSchemas(): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  const roots = [join(repoRoot, 'packages', 'core', 'src', 'contracts')];
  for (const { srcDir } of moduleSrcDirs()) {
    const contractDir = join(srcDir, 'contract');
    if (existsSync(contractDir)) roots.push(contractDir);
  }
  for (const root of roots) {
    for (const file of walk(root, '.ts')) {
      if (file.endsWith('.d.ts')) continue;
      const rel = file.replace(`${repoRoot}/`, '');
      for (const m of readFileSync(file, 'utf8').matchAll(/export const (\w+Schema)\b/g)) {
        out.push({ name: m[1] ?? '', file: rel });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function collectConfigFields(): Array<{ key: string; note: string }> {
  const src = read(
    join(repoRoot, 'packages', 'core', 'src', 'contracts', 'schemas', 'igaming-config.ts'),
  );
  const body =
    src.match(/export const IgamingConfigSchema = z\s*\.object\(\{([\s\S]*?)\}\)/)?.[1] ?? '';
  const out: Array<{ key: string; note: string }> = [];
  const lines = body.split('\n');
  let note = '';
  for (const line of lines) {
    const c = line.match(/^\s*\/\/\s?(.*)/);
    if (c) {
      note = note ? `${note} ${(c[1] ?? '').trim()}` : (c[1] ?? '').trim();
      continue;
    }
    const key = line.match(/^\s*(\w+):\s/);
    if (key) {
      out.push({ key: key[1] ?? '', note });
      note = '';
    }
  }
  return out;
}

function collectPluginSurface(): string[] {
  const src = read(
    join(repoRoot, 'packages', 'core', 'src', 'server', 'plugin-host', 'define-plugin.ts'),
  );
  const body =
    src.match(/export (?:interface|type) ModuleRegistry (?:= )?\{([\s\S]*?)\n\}/)?.[1] ?? '';
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1] ?? '').sort();
}

function collectOpenApiRoutes(): string[] {
  const spec = read(join(repoRoot, 'docs', 'openapi.json'));
  if (!spec) return [];
  try {
    const json = JSON.parse(spec);
    const paths = Object.keys(json.paths ?? {});
    const out: string[] = [];
    for (const p of paths) {
      for (const method of Object.keys(json.paths[p])) out.push(`${method.toUpperCase()} ${p}`);
    }
    return out.sort();
  } catch {
    return [];
  }
}

const catalog = {
  modules: collectModules(),
  adapters: collectAdapters(),
  events: collectEvents(),
  uiSlots: collectSlots(),
  schemas: collectSchemas(),
  config: {
    token: 'IGAMING_CONFIG',
    source: 'packages/core/src/contracts/schemas/igaming-config.ts',
    fields: collectConfigFields(),
  },
  pluginContract: collectPluginSurface(),
  httpRoutes: collectOpenApiRoutes(),
};

const docsDir = join(repoRoot, 'docs');
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(
  `[catalog] ${catalog.modules.length} modules, ${catalog.adapters.length} adapters ` +
    `(${catalog.adapters.filter((a) => a.status === 'wired').length} wired), ` +
    `${catalog.events.length} events, ${catalog.uiSlots.length} slots, ${catalog.schemas.length} schemas`,
);
console.log('[catalog] wrote docs/catalog.json');

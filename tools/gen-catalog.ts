#!/usr/bin/env node
/**
 * Generates the platform CATALOG - the machine-readable surface a downstream
 * consumer's AI agent reads INSTEAD of grepping node_modules. Emits:
 *   docs/catalog.json  - structured (consumed by @oss/mcp + tooling)
 *   docs/CATALOG.md     - human/agent-readable rendering
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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['player', 'backoffice', 'platform'] as const;

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e.startsWith('node_modules') || ['dist', '.next', '.turbo', 'coverage'].includes(e)) continue;
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

// --- modules (+ tables + routes) -------------------------------------------
type ModuleInfo = { id: string; group: string; tables: string[]; routes: string[] };

function collectModules(): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  for (const group of GROUPS) {
    const groupDir = join(repoRoot, 'packages', 'modules', group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir).sort()) {
      const dir = join(groupDir, name);
      if (!existsSync(join(dir, 'src', 'plugin.ts'))) continue;
      const schema = read(join(dir, 'src', 'schema', 'index.ts'));
      const router = read(join(dir, 'src', 'router', 'index.ts'));
      const tables = [...schema.matchAll(/pgTable\(\s*'([^']+)'/g)].map((m) => m[1]!).sort();
      const routes = [...router.matchAll(/^\s{2,}(\w+):\s*os\b/gm)]
        .map((m) => `${name}.${m[1]}`)
        .sort();
      out.push({ id: name, group, tables, routes });
    }
  }
  return out;
}

// --- adapter seams (+ wired/stub) ------------------------------------------
type AdapterInfo = {
  category: string;
  interface: string;
  token: string;
  status: 'wired' | 'stub';
  boundIn: string[];
};

function collectAdapters(): AdapterInfo[] {
  const dir = join(repoRoot, 'packages', 'contracts', 'adapters', 'src');
  const moduleFiles = GROUPS.flatMap((g) => walk(join(repoRoot, 'packages', 'modules', g), '.ts'));
  const moduleSrc = moduleFiles.map((f) => ({ f, src: readFileSync(f, 'utf8') }));
  const out: AdapterInfo[] = [];
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file === 'index.ts') continue;
    const src = readFileSync(join(dir, file), 'utf8');
    // Prefer the primary *Adapter interface over helper interfaces in the same file.
    const iface =
      src.match(/export interface (\w*Adapter)\b/)?.[1] ?? src.match(/export interface (\w+)/)?.[1] ?? '';
    const token = src.match(/export const (\w+)(?::\s*Token<[^>]*>)?\s*=\s*(?:createToken|Symbol)/)?.[1] ?? '';
    if (!token) continue;
    const boundIn = moduleSrc
      .filter(({ src }) =>
        new RegExp(`(provide\\(\\s*${token}\\b|provide:\\s*${token}\\b|\\.get\\(\\s*${token}\\b|@Inject\\(\\s*${token}\\s*\\))`).test(src),
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

// --- events ----------------------------------------------------------------
function collectEvents(): string[] {
  const set = new Set<string>();
  for (const group of GROUPS) {
    for (const f of walk(join(repoRoot, 'packages', 'modules', group), '.ts')) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\.emit\(\s*'([a-z][\w.:-]+)'/g)) set.add(m[1]!);
    }
  }
  return [...set].sort();
}

// --- UI slots --------------------------------------------------------------
function collectSlots(): Array<{ name: string; description: string }> {
  const file = join(repoRoot, 'packages', 'sdks', 'react-sdk', 'src', 'ui-plugin', 'slots.ts');
  const src = read(file);
  const out: Array<{ name: string; description: string }> = [];
  let pending = '';
  for (const line of src.split('\n')) {
    const jsdoc = line.match(/\/\*\*\s*(.+?)\s*\*\//);
    if (jsdoc) { pending = (jsdoc[1] ?? '').trim(); continue; }
    const slot = line.match(/:\s*'([a-z][a-z:]+)'/);
    if (slot) { out.push({ name: slot[1]!, description: pending }); pending = ''; }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Zod schema index ------------------------------------------------------
function collectSchemas(): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  for (const file of walk(join(repoRoot, 'packages', 'contracts'), '.ts')) {
    if (file.endsWith('.d.ts')) continue;
    const rel = file.replace(`${repoRoot}/`, '');
    for (const m of readFileSync(file, 'utf8').matchAll(/export const (\w+Schema)\b/g)) {
      out.push({ name: m[1]!, file: rel });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// --- igaming config shape (parse top-level keys + leading comment) ----------
function collectConfigFields(): Array<{ key: string; note: string }> {
  const src = read(join(repoRoot, 'packages', 'contracts', 'shared-schemas', 'src', 'igaming-config.ts'));
  const body = src.match(/export const IgamingConfigSchema = z\s*\.object\(\{([\s\S]*?)\}\)/)?.[1] ?? '';
  const out: Array<{ key: string; note: string }> = [];
  const lines = body.split('\n');
  let note = '';
  for (const line of lines) {
    const c = line.match(/^\s*\/\/\s?(.*)/);
    if (c) { note = note ? `${note} ${c[1]!.trim()}` : c[1]!.trim(); continue; }
    const key = line.match(/^\s*(\w+):\s/);
    if (key) { out.push({ key: key[1]!, note }); note = ''; }
  }
  return out;
}

// --- plugin contract surface ------------------------------------------------
function collectPluginSurface(): string[] {
  const src = read(join(repoRoot, 'packages', 'platform', 'plugin-host', 'src', 'define-plugin.ts'));
  const body = src.match(/export interface ModuleRegistry \{([\s\S]*?)\n\}/)?.[1] ?? '';
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!).sort();
}

// --- routes from emitted OpenAPI (if present) ------------------------------
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

// --- build + render --------------------------------------------------------
const catalog = {
  modules: collectModules(),
  adapters: collectAdapters(),
  events: collectEvents(),
  uiSlots: collectSlots(),
  schemas: collectSchemas(),
  config: { token: 'IGAMING_CONFIG', source: 'packages/contracts/shared-schemas/src/igaming-config.ts', fields: collectConfigFields() },
  pluginContract: collectPluginSurface(),
  httpRoutes: collectOpenApiRoutes(),
};

function md(): string {
  const L: string[] = [];
  L.push('# Platform Catalog');
  L.push('');
  L.push('> Generated by `pnpm regen` (tools/gen-catalog.ts). Do not edit by hand.');
  L.push('');
  L.push('The machine-readable surface a downstream consumer (and its AI agent) reads to');
  L.push('extend the platform - what data, routes, seams, slots, events, and config exist -');
  L.push('without reading platform internals. Structured form: `docs/catalog.json`.');
  L.push('');

  L.push('## Adapter seams (swap points)');
  L.push('');
  L.push('Implement the interface from `@oss/adapters`, bind your impl to the token in an');
  L.push('overlay plugin that loads AFTER the default-binding module (last registration wins).');
  L.push('');
  L.push('| Category | Interface | Token | Status | Bound in |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const a of catalog.adapters) {
    L.push(`| ${a.category} | \`${a.interface}\` | \`${a.token}\` | ${a.status === 'wired' ? 'wired (default impl)' : 'STUB - not yet injected'} | ${a.boundIn.map((b) => `\`${b}\``).join('<br>') || '-'} |`);
  }
  L.push('');

  L.push('## Modules');
  L.push('');
  L.push('| Module | Group | Tables | Routes |');
  L.push('| --- | --- | --- | --- |');
  for (const m of catalog.modules) {
    L.push(`| ${m.id} | ${m.group} | ${m.tables.join(', ') || '-'} | ${m.routes.join(', ') || '-'} |`);
  }
  L.push('');

  L.push('## Domain events');
  L.push('');
  L.push('Emit/subscribe via the `EventBus` a service receives in its constructor (built in `plugin.ts` from `c.get(EVENT_BUS)`, token from `@oss/core`).');
  L.push('');
  for (const e of catalog.events) L.push(`- \`${e}\``);
  L.push('');

  L.push('## UI slots');
  L.push('');
  L.push('Fill from a `defineUIPlugin` via `ctx.<slot>.add(...)`. See ADR-0006.');
  L.push('');
  L.push('| Slot | Purpose |');
  L.push('| --- | --- |');
  for (const s of catalog.uiSlots) L.push(`| \`${s.name}\` | ${s.description || '-'} |`);
  L.push('');

  L.push('## Igaming config');
  L.push('');
  L.push(`Declare with \`defineIgamingConfig({...})\` from \`@oss/shared-schemas\`, pass to`);
  L.push('`createApp({ igaming })`. Injected app-wide via the `IGAMING_CONFIG` token.');
  L.push('');
  L.push('| Field | Notes |');
  L.push('| --- | --- |');
  for (const f of catalog.config.fields) L.push(`| \`${f.key}\` | ${f.note || '-'} |`);
  L.push('');

  L.push('## Plugin contract surface');
  L.push('');
  L.push('`definePlugin({ id, register(ctx) })` - `ctx` (ModuleRegistry) exposes:');
  L.push('');
  L.push(catalog.pluginContract.map((m) => `\`ctx.${m}\``).join(', '));
  L.push('');

  L.push('## Zod schemas');
  L.push('');
  L.push(`${catalog.schemas.length} schemas. Look one up by name with the \`schema-get\` MCP tool.`);
  L.push('');
  for (const s of catalog.schemas) L.push(`- \`${s.name}\` - ${s.file}`);
  L.push('');

  if (catalog.httpRoutes.length > 0) {
    L.push('## HTTP routes (from OpenAPI)');
    L.push('');
    for (const r of catalog.httpRoutes) L.push(`- ${r}`);
    L.push('');
  }
  return L.join('\n');
}

const docsDir = join(repoRoot, 'docs');
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
writeFileSync(join(docsDir, 'CATALOG.md'), md());
console.log(
  `[catalog] ${catalog.modules.length} modules, ${catalog.adapters.length} adapters ` +
    `(${catalog.adapters.filter((a) => a.status === 'wired').length} wired), ` +
    `${catalog.events.length} events, ${catalog.uiSlots.length} slots, ${catalog.schemas.length} schemas`,
);
console.log('[catalog] wrote docs/catalog.json + docs/CATALOG.md');

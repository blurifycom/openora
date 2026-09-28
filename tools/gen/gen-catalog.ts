#!/usr/bin/env node
/**
 * Generates the platform CATALOG - the machine-readable surface a downstream
 * consumer's AI agent reads INSTEAD of grepping node_modules. Emits:
 *   docs/catalog.json               - structured, read by this repo's tooling and agents.
 *   packages/mcp/docs/catalog.json  - the same file, read at runtime by @openora/mcp: shipped in
 *                                     the published package, and resolved by a consumer running
 *                                     the server from a linked checkout.
 * Both are gitignored: generated on install (`prepare`), after a pull or branch switch (husky),
 * and by `pnpm regen`, so a committed copy can never go stale.
 * Human/agent-readable access is the MCP dev server (describe-module, list-routes)
 * plus each module's contract, schema, and plugin - no monolithic markdown dump.
 *
 * It captures: modules (+ tables + routes), adapter seams (+ wired-vs-stub
 * status), domain events, Zod schema index, the igaming-config shape,
 * the plugin-contract surface, and the agent surface (MCP tools + action types).
 *
 * Pure filesystem parsing - no package imports, no build - so it is cheap enough to run on every
 * install, and DETERMINISTIC (no timestamp).
 *
 * Run via `pnpm regen` (or `pnpm gen:catalog`). An optional first argument points it at
 * another repo root, which is how its tests run it against a fixture.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), '../..');

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

type ModuleSrc = { id: string; domain: string; srcDir: string };
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
  // Domains fold into @openora/core as subpaths. See ADR-0024/0025.
  const coreSrc = join(repoRoot, 'packages', 'core', 'src');
  const engineDirs = new Set(['contracts', 'server', 'react']);
  if (existsSync(coreSrc)) {
    for (const d of readdirSync(coreSrc)) {
      const dsrc = join(coreSrc, d);
      if (!isDir(dsrc) || engineDirs.has(d)) {
        continue;
      }
      if (hasPlugin(dsrc)) {
        out.push({ id: d, domain: d, srcDir: dsrc }); // single-member domain (incl. compliance)
      } else {
        for (const member of readdirSync(dsrc)) {
          const msrc = join(dsrc, member);
          if (isDir(msrc) && hasPlugin(msrc)) {
            out.push({ id: member, domain: d, srcDir: msrc });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) {
    return acc;
  }
  for (const e of readdirSync(dir)) {
    if (e.startsWith('node_modules') || ['dist', '.next', '.turbo', 'coverage'].includes(e)) {
      continue;
    }
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // skip broken symlinks / vanished entries
    }
    if (st.isDirectory()) {
      walk(full, ext, acc);
    } else if (full.endsWith(ext)) {
      acc.push(full);
    }
  }
  return acc;
}

type ModuleInfo = { id: string; group: string; tables: string[]; routes: string[] };

// A router nests related routes in plain object literals (`security: { me: os... }`), so a
// route's id is its full dotted path from the router root, not just its own key - two
// unrelated groups can otherwise both contribute a leaf key with the same name (`me`).
// Tracked by indentation: each `key: {` line pushes a group onto the stack at its own
// indent, popped once a later line dedents back to or past it. Blank lines are skipped
// entirely so they never look like a dedent.
function extractRoutes(moduleId: string, router: string): string[] {
  const stack: Array<{ indent: number; name: string }> = [];
  const routes: string[] = [];
  for (const line of router.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    while (stack.length > 0 && indent <= (stack[stack.length - 1]?.indent ?? -1)) {
      stack.pop();
    }
    const group = line.match(/^\s{2,}(\w+):\s*\{\s*$/);
    if (group) {
      stack.push({ indent, name: group[1] ?? '' });
      continue;
    }
    const route = line.match(/^\s{2,}(\w+):\s*os\b/);
    if (route) {
      routes.push([moduleId, ...stack.map((s) => s.name), route[1]].join('.'));
    }
  }
  return routes.sort();
}

function collectModules(): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  for (const { id, domain, srcDir } of moduleSrcDirs()) {
    const schema = read(join(srcDir, 'schema', 'index.ts'));
    const router = read(join(srcDir, 'router', 'index.ts'));
    const tables = [...schema.matchAll(/pgTable\(\s*'([^']+)'/g)].map((m) => m[1] ?? '').sort();
    const routes = extractRoutes(id, router);
    out.push({ id, group: domain, tables, routes });
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
  // Scan every module plus the engine app factory, so platform-level default
  // bindings (eg the in-process MESSAGE_BROKER seeded in create-app) count as wired.
  const moduleFiles = [
    ...moduleSrcDirs().flatMap(({ srcDir }) => walk(srcDir, '.ts')),
    ...walk(join(repoRoot, 'packages', 'core', 'src', 'server', 'runtime'), '.ts'),
  ];
  const moduleSrc = moduleFiles.map((f) => ({ f, src: readFileSync(f, 'utf8') }));
  const out: AdapterInfo[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file === 'index.ts') {
      continue;
    }
    const src = readFileSync(join(dir, file), 'utf8');
    const iface =
      src.match(/export (?:interface|type) (\w*Adapter)\b/)?.[1] ??
      src.match(/export (?:interface|type) (\w+)/)?.[1] ??
      '';
    const token =
      src.match(
        /export const (\w+)(?::\s*(?:Sealed)?Token<[^>]*>)?\s*=\s*(?:createSealedToken|createToken|Symbol)/,
      )?.[1] ?? '';
    if (!token) {
      continue;
    }
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
      for (const m of readFileSync(f, 'utf8').matchAll(/\.emit\(\s*'([a-z][\w.:-]+)'/g)) {
        set.add(m[1] ?? '');
      }
    }
  }
  return [...set].sort();
}

// Each module owns its route contract under contract/, so the schema index spans both the cross-cutting core contracts zone and every module contract dir. See ADR-0021.
function collectSchemas(): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  const roots = [join(repoRoot, 'packages', 'core', 'src', 'contracts')];
  for (const { srcDir } of moduleSrcDirs()) {
    const contractDir = join(srcDir, 'contract');
    if (existsSync(contractDir)) {
      roots.push(contractDir);
    }
  }
  for (const root of roots) {
    for (const file of walk(root, '.ts')) {
      if (file.endsWith('.d.ts')) {
        continue;
      }
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
    src.match(
      /export (?:interface|type) ModuleRegistry(?:<[^>]+>)? (?:= )?\{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1] ?? '').sort();
}

// The agent surface is read from the object literal passed to defineMcpTool({...}) /
// defineActionType({...}), so the generator stays a text pass and never imports a module.
// Only literal values are catalogued; a non-literal id is skipped with a warning.

type AgentIam = { resource: string; action: string };

type AgentToolInfo = {
  id: string;
  module: string;
  file: string;
  title: string | null;
  description: string | null;
  class: string | null;
  schemaVersion: number | null;
  iam: AgentIam | null;
};

type AgentActionInfo = {
  id: string;
  module: string;
  file: string;
  title: string | null;
  description: string | null;
  schemaVersion: number | null;
  iam: AgentIam | null;
  reversible: boolean | null;
};

// A '/' after one of these characters or words starts a regex literal, not a division.
const REGEX_PRECEDERS = '(,=:[!&|?{};>';
const REGEX_PRECEDING_WORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
  'yield',
  'await',
]);
const IDENTIFIER_CHAR = /[\w$]/;
const CLOSERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

function startsRegex(prev: string, prevWord: string): boolean {
  return prev === '' || REGEX_PRECEDERS.includes(prev) || REGEX_PRECEDING_WORDS.has(prevWord);
}

// Tracks the identifier that ends right before position `i`, so `return /x/` reads as a regex.
function nextWord(src: string, i: number, prevWord: string): string {
  const ch = src[i] ?? '';
  if (IDENTIFIER_CHAR.test(ch)) {
    return IDENTIFIER_CHAR.test(src[i - 1] ?? '') ? prevWord + ch : ch;
  }
  return /\s/.test(ch) ? prevWord : '';
}

function skipString(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
    } else if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      i = closingBracket(src, i + 1);
      if (i < 0) {
        return -1;
      }
    } else if (ch === quote) {
      return i;
    }
  }
  return -1;
}

// A zod `.regex(/[^}]/)` inside a contract literal must not unbalance the brace count.
function skipRegex(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === ']') {
      inClass = false;
    } else if (ch === '/' && !inClass) {
      while (/[a-z]/.test(src[i + 1] ?? '')) {
        i++;
      }
      return i;
    } else if (ch === '\n') {
      return -1;
    }
  }
  return -1;
}

// Calls `visit` for every top-level character outside strings, comments and regex literals;
// a nested bracket is visited at its opening character and then skipped whole. Returns false
// when the text is unbalanced.
function scanTopLevel(
  src: string,
  from: number,
  visit: (ch: string, index: number) => 'stop' | void,
): boolean {
  let prev = '';
  let prevWord = '';
  for (let i = from; i < src.length; i++) {
    const ch = src[i] ?? '';
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const newline = src.indexOf('\n', i);
      i = newline === -1 ? src.length : newline;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close === -1) {
        return false;
      }
      i = close + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(src, i);
      if (i < 0) {
        return false;
      }
      prev = 'x';
      prevWord = '';
      continue;
    }
    if (ch === '/' && startsRegex(prev, prevWord)) {
      i = skipRegex(src, i);
      if (i < 0) {
        return false;
      }
      prev = 'x';
      prevWord = '';
      continue;
    }
    if (visit(ch, i) === 'stop') {
      return true;
    }
    if (ch in CLOSERS) {
      i = closingBracket(src, i);
      if (i < 0) {
        return false;
      }
      prev = ')';
      prevWord = '';
      continue;
    }
    prevWord = nextWord(src, i, prevWord);
    if (!/\s/.test(ch)) {
      prev = ch;
    }
  }
  return true;
}

// The source with every comment blanked and every offset kept, so a call written inside a
// comment (a JSDoc example) is never read as a registration.
function withoutComments(src: string): string {
  const out = src.split('');
  let prev = '';
  let prevWord = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? '';
    const next = src[i + 1];
    if (ch === '/' && (next === '/' || next === '*')) {
      const end = next === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : next === '/' ? end : end + 2;
      for (let j = i; j < stop; j++) {
        if (out[j] !== '\n') {
          out[j] = ' ';
        }
      }
      i = stop - 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(src, i);
      if (end < 0) {
        break;
      }
      i = end;
      prev = 'x';
      prevWord = '';
      continue;
    }
    if (ch === '/' && startsRegex(prev, prevWord)) {
      const end = skipRegex(src, i);
      if (end >= 0) {
        i = end;
        prev = 'x';
        prevWord = '';
        continue;
      }
    }
    prevWord = nextWord(src, i, prevWord);
    if (!/\s/.test(ch)) {
      prev = ch;
    }
  }
  return out.join('');
}

function closingBracket(src: string, open: number): number {
  const expected = CLOSERS[src[open] ?? ''];
  let found = -1;
  const balanced = scanTopLevel(src, open + 1, (ch, i) => {
    if (ch === '}' || ch === ']' || ch === ')') {
      found = ch === expected ? i : -1;
      return 'stop';
    }
  });
  return balanced ? found : -1;
}

// The object literal bodies passed as the first argument to `fnName(` or `fnName<...>(`.
function callObjectArguments(src: string, fnName: string, file: string): string[] {
  const code = withoutComments(src);
  const out: string[] = [];
  const call = new RegExp(`\\b${fnName}\\s*(?:<[^()]*?>)?\\s*\\(\\s*\\{`, 'g');
  for (const m of code.matchAll(call)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = closingBracket(code, open);
    if (close > open) {
      out.push(src.slice(open + 1, close));
    } else {
      console.warn(`[catalog] ${file}: ${fnName}({...}) could not be parsed - skipped`);
    }
  }
  return out;
}

function objectEntries(body: string): Map<string, string> {
  const segments: string[] = [];
  let start = 0;
  scanTopLevel(body, 0, (ch, i) => {
    if (ch === ',') {
      segments.push(body.slice(start, i));
      start = i + 1;
    }
  });
  segments.push(body.slice(start));
  const entries = new Map<string, string>();
  for (const raw of segments) {
    const segment = raw.replace(/^(?:\s*(?:\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/, '').trim();
    const m = segment.match(/^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/);
    if (m) {
      entries.set(m[1] ?? m[2] ?? m[3] ?? '', (m[4] ?? '').trim());
    }
  }
  return entries;
}

const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`/g;

function stringLiteral(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const parts = [...value.matchAll(STRING_LITERAL)].map((m) => m[0]);
  if (parts.length === 0 || value.replace(STRING_LITERAL, '').replace(/[\s+]/g, '') !== '') {
    return null;
  }
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

function numberLiteral(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function booleanLiteral(value: string | undefined): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null;
}

function iamLiteral(value: string | undefined): AgentIam | null {
  const body = value?.match(/^\{([\s\S]*)\}$/)?.[1];
  if (body === undefined) {
    return null;
  }
  const entries = objectEntries(body);
  const resource = stringLiteral(entries.get('resource'));
  const action = stringLiteral(entries.get('action'));
  return resource && action ? { resource, action } : null;
}

function collectAgentSurface(): { tools: AgentToolInfo[]; actions: AgentActionInfo[] } {
  const tools: AgentToolInfo[] = [];
  const actions: AgentActionInfo[] = [];
  for (const { id: module, srcDir } of moduleSrcDirs()) {
    const files = walk(srcDir, '.ts').filter(
      (f) => !f.includes('/__tests__/') && !f.endsWith('.d.ts'),
    );
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const file = f.replace(`${repoRoot}/`, '');
      for (const [fnName, kind] of [
        ['defineMcpTool', 'tool'],
        ['defineActionType', 'action'],
      ] as const) {
        for (const body of callObjectArguments(src, fnName, file)) {
          const entries = objectEntries(body);
          const id = stringLiteral(entries.get('id'));
          if (!id) {
            console.warn(`[catalog] ${file}: ${fnName}({...}) without a literal id - skipped`);
            continue;
          }
          const common = {
            id,
            module,
            file,
            title: stringLiteral(entries.get('title')),
            description: stringLiteral(entries.get('description')),
            schemaVersion: numberLiteral(entries.get('schemaVersion')),
            iam: iamLiteral(entries.get('iam')),
          };
          if (kind === 'tool') {
            tools.push({ ...common, class: stringLiteral(entries.get('class')) });
          } else {
            actions.push({ ...common, reversible: booleanLiteral(entries.get('reversible')) });
          }
        }
      }
    }
  }
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return { tools: tools.sort(byId), actions: actions.sort(byId) };
}

const agentSurfaceInfo = collectAgentSurface();

const catalog = {
  modules: collectModules(),
  adapters: collectAdapters(),
  events: collectEvents(),
  schemas: collectSchemas(),
  config: {
    token: 'IGAMING_CONFIG',
    source: 'packages/core/src/contracts/schemas/igaming-config.ts',
    fields: collectConfigFields(),
  },
  pluginContract: collectPluginSurface(),
  agentTools: agentSurfaceInfo.tools,
  agentActions: agentSurfaceInfo.actions,
};

const docsDir = join(repoRoot, 'docs');
const catalogJson = JSON.stringify(catalog, null, 2) + '\n';
for (const dir of [docsDir, join(repoRoot, 'packages', 'mcp', 'docs')]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'catalog.json'), catalogJson);
}
console.log(
  `[catalog] ${catalog.modules.length} modules, ${catalog.adapters.length} adapters ` +
    `(${catalog.adapters.filter((a) => a.status === 'wired').length} wired), ` +
    `${catalog.events.length} events, ${catalog.schemas.length} schemas, ` +
    `${catalog.agentTools.length} agent tools, ${catalog.agentActions.length} action types`,
);
console.log('[catalog] wrote docs/catalog.json and packages/mcp/docs/catalog.json');

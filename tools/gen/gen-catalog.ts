#!/usr/bin/env node
/**
 * Generates the platform CATALOG - the machine-readable surface a downstream
 * consumer's AI agent reads INSTEAD of grepping node_modules. Emits:
 *   docs/catalog.json  - structured, consumed at runtime by the published @openora/mcp
 *                        server (a consumer's node_modules has no platform source).
 * Human/agent-readable access is the MCP dev server (describe-module, list-routes)
 * plus each module's contract, schema, and plugin - no monolithic markdown dump.
 *
 * It captures: modules (+ tables + routes), adapter seams (+ wired-vs-stub
 * status), domain events, Zod schema index, the igaming-config shape,
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

function collectModules(): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  for (const { id, domain, srcDir } of moduleSrcDirs()) {
    const schema = read(join(srcDir, 'schema', 'index.ts'));
    const router = read(join(srcDir, 'router', 'index.ts'));
    const tables = [...schema.matchAll(/pgTable\(\s*'([^']+)'/g)].map((m) => m[1] ?? '').sort();
    const routes = [...router.matchAll(/^\s{2,}(\w+):\s*os\b/gm)]
      .map((m) => `${id}.${m[1]}`)
      .sort();
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
};

const docsDir = join(repoRoot, 'docs');
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(
  `[catalog] ${catalog.modules.length} modules, ${catalog.adapters.length} adapters ` +
    `(${catalog.adapters.filter((a) => a.status === 'wired').length} wired), ` +
    `${catalog.events.length} events, ${catalog.schemas.length} schemas`,
);
console.log('[catalog] wrote docs/catalog.json');

// The domain reference table in system-design.md is derived from the same data, so it is
// generated rather than hand-maintained - it drifted badly when it was not. Everything else
// in that file is hand-written prose and is left untouched.
const REFERENCE_START = '<!-- gen:catalog-reference -->';
const REFERENCE_END = '<!-- /gen:catalog-reference -->';

const DOMAIN_PACKAGE: Record<string, string> = {
  'admin-console': '@openora/core/admin-console',
  analytics: '@openora/core/analytics',
  audit: '@openora/core/audit',
  casino: '@openora/core/casino',
  cms: '@openora/core/cms',
  compliance: '@openora/core/compliance',
  engagement: '@openora/core/engagement',
  iam: '@openora/core/iam',
  pam: '@openora/core/pam',
  wallet: '@openora/core/wallet',
};

const byDomain = new Map<string, { modules: string[]; tables: string[]; routes: number }>();
for (const module of catalog.modules) {
  const entry = byDomain.get(module.group) ?? { modules: [], tables: [], routes: 0 };
  entry.modules.push(module.id);
  entry.tables.push(...module.tables);
  entry.routes += module.routes.length;
  byDomain.set(module.group, entry);
}

const summarize = (tables: string[]) =>
  tables.length === 0
    ? '(owns none - reads through ports)'
    : tables.length <= 4
      ? tables.join(', ')
      : `${tables.slice(0, 4).join(', ')} + ${tables.length - 4} more`;

// Padded to the widest cell per column so the emitted table already matches what the
// formatter would produce - otherwise `pnpm gen:catalog` and `pnpm check:format` would
// fight each other and the drift check would never settle.
const renderTable = (header: string[], rows: string[][]) => {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
};

const referenceTable = [
  `Generated from \`docs/catalog.json\` - ${catalog.modules.length} modules, ` +
    `${[...byDomain.values()].reduce((n, d) => n + d.routes, 0)} routes, ` +
    `${catalog.adapters.length} adapter ports, ${catalog.events.length} events. ` +
    'Edit the code, then run `pnpm gen:catalog`.',
  '',
  renderTable(
    ['Domain', 'Modules', 'Tables', 'Routes'],
    [...byDomain.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, d]) => [
        `\`${DOMAIN_PACKAGE[domain] ?? domain}\``,
        d.modules.sort().join(' · '),
        summarize(d.tables.sort()),
        String(d.routes),
      ]),
  ),
].join('\n');

const systemDesignPath = join(docsDir, 'platform', 'system-design.md');
const systemDesign = readFileSync(systemDesignPath, 'utf8');
const start = systemDesign.indexOf(REFERENCE_START);
const end = systemDesign.indexOf(REFERENCE_END);
if (start === -1 || end === -1) {
  throw new Error(
    `[catalog] ${systemDesignPath} is missing the ${REFERENCE_START} / ${REFERENCE_END} markers.`,
  );
}
writeFileSync(
  systemDesignPath,
  systemDesign.slice(0, start + REFERENCE_START.length) +
    `\n\n${referenceTable}\n\n` +
    systemDesign.slice(end),
);
console.log('[catalog] wrote docs/platform/system-design.md reference table');

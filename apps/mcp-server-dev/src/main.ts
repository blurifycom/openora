import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(...parts: string[]): string {
  return join(repoRoot, ...parts);
}

function readFile(p: string): string {
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

function listDirs(p: string): string[] {
  if (!existsSync(p)) return [];
  return readdirSync(p).filter((f) => statSync(join(p, f)).isDirectory());
}

// Modules live under packages/modules/<group>/<name>/ (one @oss/modules package).
const MODULE_GROUPS = ['player', 'backoffice', 'platform'] as const;

/** Resolve a module's source dir by name across the grouped layout. */
function findModuleDir(name: string): string | null {
  for (const group of MODULE_GROUPS) {
    const dir = repoPath('packages', 'modules', group, name);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Every module across all groups, with a plugin.ts. */
function listAllModules(): Array<{ group: string; name: string; dir: string }> {
  const out: Array<{ group: string; name: string; dir: string }> = [];
  for (const group of MODULE_GROUPS) {
    const groupDir = repoPath('packages', 'modules', group);
    for (const name of listDirs(groupDir)) {
      const dir = join(groupDir, name);
      if (existsSync(join(dir, 'src', 'plugin.ts'))) out.push({ group, name, dir });
    }
  }
  return out;
}

function parseAgentsMdSection(content: string, heading: string): string {
  const lines = content.split('\n');
  let capture = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ') && line.slice(3).trim() === heading) {
      capture = true;
      continue;
    }
    if (capture && line.startsWith('## ')) break;
    if (capture) out.push(line);
  }
  return out.join('\n').trim();
}

function listModulesFromConfig(): Array<{ id: string; path: string }> {
  const configPath = repoPath('extensions.config.ts');
  if (!existsSync(configPath)) return [];
  const src = readFileSync(configPath, 'utf8');
  const matches = [...src.matchAll(/\{\s*id:\s*'([^']+)',\s*path:\s*'([^']+)'\s*\}/g)];
  return matches.map((m) => ({ id: m[1]!, path: m[2]! }));
}

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
    });
    return { ok: true, output };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
    return {
      ok: false,
      output: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '') + err.message,
    };
  }
}

/** Recursively collect files under `dir` matching `ext`, skipping build/vendor dirs. */
function walkFiles(dir: string, ext: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.turbo') {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, ext, acc);
    else if (full.endsWith(ext)) acc.push(full);
  }
  return acc;
}

/**
 * Extract a single `export const <name> = ...;` declaration from source by
 * tracking bracket depth, so the whole (possibly multi-line) Zod schema is
 * returned. Returns null if not found.
 */
function extractDeclaration(src: string, name: string): { line: number; code: string } | null {
  const lines = src.split('\n');
  const startRe = new RegExp(`^\\s*export\\s+const\\s+${name}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (!startRe.test(lines[i]!)) continue;
    let depth = 0;
    let started = false;
    const out: string[] = [];
    for (let j = i; j < lines.length; j++) {
      const l = lines[j]!;
      out.push(l);
      for (const ch of l) {
        if (ch === '(' || ch === '{' || ch === '[') {
          depth++;
          started = true;
        } else if (ch === ')' || ch === '}' || ch === ']') depth--;
      }
      if (started && depth <= 0) break;
      if (!started && l.includes(';')) break;
    }
    return { line: i + 1, code: out.join('\n') };
  }
  return null;
}

/** DATABASE_URL from env, or the local docker default (mirrors tools/seed.ts). */
function resolveDatabaseUrl(): string {
  return (
    process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/oss_casino'
  );
}

const READONLY_SQL_PREFIXES = ['select', 'with', 'explain', 'show', 'table', 'values'];

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'oss-dev',
  version: '0.1.0',
});

// --- read-agents-md ---------------------------------------------------------
server.tool(
  'read-agents-md',
  'Read a section of AGENTS.md (or a package-level AGENTS.md) by heading name.',
  {
    section: z.string().optional().describe('H2 heading to read (omit for the full file)'),
    package: z
      .string()
      .optional()
      .describe('Package name or path relative to repo root (omit for root AGENTS.md)'),
  },
  async ({ section, package: pkg }) => {
    const filePath = pkg
      ? repoPath(pkg.replace(/^@oss\//, ''), 'AGENTS.md')
      : repoPath('AGENTS.md');
    const content = readFile(filePath);
    if (!content) return { content: [{ type: 'text', text: `No AGENTS.md found at ${filePath}` }] };
    const text = section
      ? parseAgentsMdSection(content, section) || `Section "${section}" not found.`
      : content;
    return { content: [{ type: 'text', text }] };
  },
);

// --- list-modules -----------------------------------------------------------
server.tool(
  'list-modules',
  'List all registered modules/extensions from extensions.config.ts.',
  {},
  async () => {
    const modules = listModulesFromConfig();
    if (modules.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No modules registered yet (extensions.config.ts missing or empty).',
          },
        ],
      };
    }
    const lines = modules.map((m) => `- ${m.id}  (${m.path})`).join('\n');
    return { content: [{ type: 'text', text: lines }] };
  },
);

// --- describe-module --------------------------------------------------------
server.tool(
  'describe-module',
  "Everything you need to edit a module in one call: its AGENTS.md, Drizzle tables, Zod schemas, and router surface. Prefer this over reading the files individually.",
  {
    name: z.string().describe('Module name (kebab-case)'),
    response_format: z
      .enum(['concise', 'detailed'])
      .optional()
      .describe(
        'concise (default): AGENTS.md + table/schema/route names only. detailed: full source of every file.',
      ),
  },
  async ({ name, response_format }) => {
    const detailed = response_format === 'detailed';
    const overlayBase = repoPath('apps', 'extensions', name);
    const dir = findModuleDir(name) ?? (existsSync(overlayBase) ? overlayBase : null);

    if (!dir) {
      return {
        content: [
          {
            type: 'text',
            text: `Module "${name}" not found. Run list-modules to see registered modules.`,
          },
        ],
      };
    }

    const schemaSrc = readFile(join(dir, 'src', 'schema', 'index.ts'));
    const zodSrc = readFile(join(dir, 'src', 'schemas', 'index.ts'));
    const routerSrc = readFile(join(dir, 'src', 'router', 'index.ts'));
    const parts: string[] = [`=== Module: ${name} ===\n`, readFile(join(dir, 'AGENTS.md')) || '(no AGENTS.md)'];

    if (detailed) {
      parts.push('\n--- Drizzle tables (src/schema/index.ts) ---', schemaSrc || '(no tables)');
      parts.push('\n--- Zod schemas (src/schemas/index.ts) ---', zodSrc || '(empty)');
      parts.push('\n--- Router ---', routerSrc || '(empty)');
    } else {
      const tables = [...schemaSrc.matchAll(/pgTable\(\s*'([^']+)'/g)].map((m) => m[1]);
      const zods = [...zodSrc.matchAll(/export const (\w+Schema)\b/g)].map((m) => m[1]);
      const routes = [...routerSrc.matchAll(/^\s{2,}(\w+):\s*os\b/gm)].map((m) => `${name}.${m[1]}`);
      parts.push(`\n--- Tables ---\n${tables.join(', ') || '(none)'}`);
      parts.push(`\n--- Schemas ---\n${zods.join(', ') || '(none)'}`);
      parts.push(`\n--- Routes ---\n${routes.join(', ') || '(none)'}`);
      parts.push('\n(Pass response_format: "detailed" for full source.)');
    }

    return { content: [{ type: 'text', text: parts.join('\n') }] };
  },
);

// --- list-routes ------------------------------------------------------------
server.tool(
  'list-routes',
  'List all oRPC route namespaces across modules. Pass module name to filter.',
  { module: z.string().optional() },
  async ({ module: mod }) => {
    const all = listAllModules();
    const modules = mod ? all.filter((m) => m.name === mod) : all;
    const lines: string[] = [];
    for (const { name, dir } of modules) {
      const routerFile = join(dir, 'src', 'router', 'index.ts');
      if (!existsSync(routerFile)) continue;
      const src = readFileSync(routerFile, 'utf8');
      const procedures = [...src.matchAll(/^\s{2,}(\w+):\s*os\b/gm)].map((m) => `  ${name}.${m[1]}`);
      if (procedures.length > 0) lines.push(`${name}:\n${procedures.join('\n')}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n\n') || 'No routes defined yet.' }] };
  },
);

// --- list-extension-points --------------------------------------------------
server.tool(
  'list-extension-points',
  'List all named UI slots, exported event types, and port interfaces across the platform.',
  {},
  async () => {
    const parts: string[] = [];

    // Named UI slots from react-sdk/src/ui-plugin/slots.ts (the SLOTS constant)
    const slotsFile = repoPath(
      'packages', 'sdks', 'react-sdk', 'src', 'ui-plugin', 'slots.ts',
    );
    if (existsSync(slotsFile)) {
      const src = readFileSync(slotsFile, 'utf8');
      // Extract JSDoc + slot name pairs. Format: /** ...comment */ \n key: 'slot:name'
      const slotLines: string[] = [];
      const lines = src.split('\n');
      let pending = '';
      for (const line of lines) {
        const jsdoc = line.match(/\/\*\*\s*(.+?)\s*\*\//);
        if (jsdoc) { pending = (jsdoc[1] ?? '').trim(); continue; }
        const slot = line.match(/:\s*'([a-z:]+)'/);
        if (slot) {
          slotLines.push(pending ? `- ${slot[1]}  # ${pending}` : `- ${slot[1]}`);
          pending = '';
        }
      }
      parts.push(
        `=== Named UI slots (import SLOTS from @oss/react-sdk) ===\n` +
        `Fill with ctx.slots.fill(name, options, render) or ctx.slots.column(name, colDef).\n` +
        `Declare in pages with <Slot name={SLOTS.x.y} subject={entity}>.\n\n` +
        (slotLines.join('\n') || '(none defined yet)'),
      );
    }

    // Events from @oss/core
    const eventsFile = repoPath('packages', 'platform', 'core', 'src', 'event-bus.ts');
    if (existsSync(eventsFile)) {
      parts.push(`\n=== Events (EventBus from @oss/core) ===\n${readFile(eventsFile)}`);
    } else {
      parts.push('\n=== Events ===\n(event-bus.ts not found)');
    }

    // Vendor adapter interfaces from @oss/adapters (the single home for the swap seams)
    const adaptersDir = repoPath('packages', 'contracts', 'adapters', 'src');
    parts.push('\n=== Adapter interfaces (@oss/adapters) ===');
    if (existsSync(adaptersDir)) {
      for (const f of readdirSync(adaptersDir)) {
        if (!f.endsWith('.ts') || f === 'index.ts') continue;
        const src = readFileSync(join(adaptersDir, f), 'utf8');
        const interfaces = [...src.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]);
        const tokens = [...src.matchAll(/^export const (\w+) = Symbol/gm)].map((m) => m[1]);
        const label = [...interfaces, ...tokens.map((t) => `${t} (token)`)].join(', ');
        if (label) parts.push(`${f.replace(/\.ts$/, '')}: ${label}`);
      }
    }

    return { content: [{ type: 'text', text: parts.join('\n') }] };
  },
);

// --- query-openapi ----------------------------------------------------------
server.tool(
  'query-openapi',
  'Search the generated OpenAPI spec for paths or operations matching a keyword.',
  { keyword: z.string() },
  async ({ keyword }) => {
    const specPath = repoPath('docs', 'openapi.json');
    if (!existsSync(specPath)) {
      return {
        content: [
          { type: 'text', text: 'OpenAPI spec not generated yet. Run `pnpm regen` first.' },
        ],
      };
    }
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const kw = keyword.toLowerCase();
    const matches: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      if (path.toLowerCase().includes(kw)) {
        const methodList = Object.keys(methods as object)
          .join(', ')
          .toUpperCase();
        matches.push(`${methodList} ${path}`);
      }
    }
    return {
      content: [
        {
          type: 'text',
          text:
            matches.length > 0
              ? `Routes matching "${keyword}":\n${matches.join('\n')}`
              : `No routes match "${keyword}"`,
        },
      ],
    };
  },
);

// --- scaffold-* (delegating to tools/scaffold.ts) ---------------------------
server.tool(
  'scaffold-module',
  'Scaffold a new business module under packages/modules/<group>/<name>.',
  {
    group: z.enum(['player', 'backoffice', 'platform']),
    name: z.string(),
  },
  async ({ group, name }) => {
    const result = run(`pnpm scaffold module ${group} ${name}`);
    return {
      content: [{ type: 'text', text: result.output || (result.ok ? 'Done.' : 'Failed.') }],
    };
  },
);

server.tool(
  'scaffold-plugin',
  'Scaffold a new overlay extension under apps/extensions/<name>.',
  { name: z.string() },
  async ({ name }) => {
    const result = run(`pnpm scaffold plugin ${name}`);
    return {
      content: [{ type: 'text', text: result.output || (result.ok ? 'Done.' : 'Failed.') }],
    };
  },
);

server.tool(
  'scaffold-route',
  'Add an oRPC route stub to a module',
  {
    module: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string(),
  },
  async ({ module: mod, method, path }) => {
    const result = run(`pnpm scaffold route ${mod} ${method} ${path}`);
    return {
      content: [{ type: 'text', text: result.output || (result.ok ? 'Done.' : 'Failed.') }],
    };
  },
);

// --- run-verify -------------------------------------------------------------
server.tool(
  'run-verify',
  'Run pnpm verify (typecheck + lint + unit tests). Pass filter to scope to one package.',
  { filter: z.string().optional() },
  async ({ filter }) => {
    const cmd = filter ? `pnpm verify --filter "${filter}"` : 'pnpm verify';
    const result = run(cmd);
    return {
      content: [
        {
          type: 'text',
          text: (result.ok ? '[PASS]\n' : '[FAIL]\n') + result.output,
        },
      ],
    };
  },
);

// --- regen ------------------------------------------------------------------
server.tool(
  'regen',
  'Run pnpm regen: drizzle-kit generate (migrations from pgTable schemas) + emit OpenAPI spec + regenerate the typed SDK.',
  {},
  async () => {
    const result = run('pnpm regen');
    return {
      content: [
        {
          type: 'text',
          text: (result.ok ? '[PASS]\n' : '[FAIL]\n') + result.output,
        },
      ],
    };
  },
);

// --- get-drizzle-schema -----------------------------------------------------
server.tool(
  'get-drizzle-schema',
  'Return the Drizzle table definitions (pgTable) across all modules. Pass a module name to scope to one. Source of truth for the DB shape - read this instead of grepping schema files.',
  {
    module: z.string().optional().describe('Module name (kebab-case) to scope to'),
    response_format: z
      .enum(['concise', 'detailed'])
      .optional()
      .describe('concise (default): table names + columns. detailed: full pgTable source.'),
  },
  async ({ module: mod, response_format }) => {
    const detailed = response_format === 'detailed';
    const all = listAllModules();
    const modules = mod ? all.filter((m) => m.name === mod) : all;
    if (mod && modules.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Module "${mod}" not found. Run list-modules to see available modules.`,
          },
        ],
      };
    }
    const parts: string[] = [];
    for (const { group, name, dir } of modules) {
      const schemaFile = join(dir, 'src', 'schema', 'index.ts');
      if (!existsSync(schemaFile)) continue;
      const src = readFileSync(schemaFile, 'utf8');
      const tables = [...src.matchAll(/export const (\w+)\s*=\s*pgTable\(\s*'([^']+)'/g)];
      if (tables.length === 0) continue;
      if (detailed) {
        parts.push(`=== ${group}/${name} (src/schema/index.ts) ===\n${src.trim()}`);
      } else {
        const summary = tables.map(([, constName, tableName]) => `  ${constName} -> '${tableName}'`);
        parts.push(`${group}/${name}:\n${summary.join('\n')}`);
      }
    }
    const text = parts.join('\n\n') || 'No Drizzle tables found.';
    return {
      content: [
        {
          type: 'text',
          text: detailed
            ? text
            : `${text}\n\n(Pass response_format: "detailed" for full pgTable source, or scope with module.)`,
        },
      ],
    };
  },
);

// --- propose-table-change ---------------------------------------------------
server.tool(
  'propose-table-change',
  'Check a proposed Drizzle table name for collisions across all module schemas before you add a pgTable. Returns [OK] or [COLLISION] with the owning module.',
  { table: z.string().describe("snake_case pgTable name, e.g. 'tournament_entry'") },
  async ({ table }) => {
    const want = table.trim();
    for (const { group, name, dir } of listAllModules()) {
      const schemaFile = join(dir, 'src', 'schema', 'index.ts');
      if (!existsSync(schemaFile)) continue;
      const src = readFileSync(schemaFile, 'utf8');
      for (const [, , tableName] of src.matchAll(/pgTable\(\s*'([^']+)'/g)) {
        if (tableName === want) {
          return {
            content: [
              {
                type: 'text',
                text: `[COLLISION] Table '${want}' already defined in packages/modules/${group}/${name}/src/schema/index.ts. Pick a different name or add a column to the existing table.`,
              },
            ],
          };
        }
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: `[OK] Table name '${want}' is available. Add the pgTable to your module's src/schema/index.ts, then run pnpm regen to generate the migration.`,
        },
      ],
    };
  },
);

// --- schema-get -------------------------------------------------------------
server.tool(
  'schema-get',
  'Find a Zod domain schema by name and return its definition with file location. Searches packages/contracts/*.',
  { name: z.string().describe('Schema name, e.g. "WalletBalance" or "WalletBalanceSchema"') },
  async ({ name }) => {
    const candidates = name.endsWith('Schema') ? [name] : [`${name}Schema`, name];
    const files = walkFiles(repoPath('packages', 'contracts'), '.ts').filter(
      (f) => !f.endsWith('.d.ts'),
    );
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const cand of candidates) {
        const decl = extractDeclaration(src, cand);
        if (decl) {
          const rel = file.replace(`${repoRoot}/`, '');
          return {
            content: [{ type: 'text', text: `${rel}:${decl.line}\n\n${decl.code}` }],
          };
        }
      }
    }
    // Not found: list available schema names to help the caller.
    const names = new Set<string>();
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/export const (\w+Schema)\b/g)) {
        names.add(m[1]!);
      }
    }
    const list = [...names].sort().join(', ');
    return {
      content: [
        { type: 'text', text: `Schema "${name}" not found.\n\nAvailable schemas:\n${list}` },
      ],
    };
  },
);

// --- docs-search ------------------------------------------------------------
server.tool(
  'docs-search',
  'Search markdown docs (docs/, README, AGENTS.md, ADRs, per-package AGENTS.md) for a keyword. Returns matching lines with locations.',
  {
    query: z.string().describe('Case-insensitive substring to search for'),
    limit: z.number().optional().describe('Max matching lines to return (default 60)'),
  },
  async ({ query, limit }) => {
    const max = limit ?? 60;
    const roots = [repoPath('docs'), repoPath('packages'), repoPath('apps')];
    const files = new Set<string>([repoPath('README.md'), repoPath('AGENTS.md')]);
    for (const root of roots) for (const f of walkFiles(root, '.md')) files.add(f);

    const needle = query.toLowerCase();
    const hits: string[] = [];
    for (const file of [...files].sort()) {
      if (!existsSync(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      const rel = file.replace(`${repoRoot}/`, '');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          hits.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
          if (hits.length >= max) break;
        }
      }
      if (hits.length >= max) break;
    }
    return {
      content: [
        {
          type: 'text',
          text:
            hits.length > 0
              ? `${hits.length} match(es) for "${query}":\n${hits.join('\n')}`
              : `No docs match "${query}".`,
        },
      ],
    };
  },
);

// --- db-query-readonly ------------------------------------------------------
server.tool(
  'db-query-readonly',
  'Run a read-only SQL query against the dev database (wrapped in a READ ONLY transaction). Only SELECT/WITH/EXPLAIN/SHOW/TABLE/VALUES are allowed; results capped at 200 rows.',
  { sql: z.string().describe('A single read-only SQL statement') },
  async ({ sql }) => {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    const lower = trimmed.toLowerCase();
    if (trimmed.includes(';')) {
      return { content: [{ type: 'text', text: 'Only a single statement is allowed (no `;`).' }] };
    }
    if (!READONLY_SQL_PREFIXES.some((p) => lower.startsWith(p))) {
      return {
        content: [
          {
            type: 'text',
            text: `Read-only queries only. Allowed prefixes: ${READONLY_SQL_PREFIXES.join(', ')}.`,
          },
        ],
      };
    }
    const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
    try {
      await client.connect();
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query("SET LOCAL statement_timeout = '10s'");
      const res = await client.query(trimmed);
      await client.query('ROLLBACK');
      const rows = res.rows.slice(0, 200);
      const text =
        rows.length === 0
          ? '(0 rows)'
          : `${res.rowCount} row(s)${res.rowCount && res.rowCount > 200 ? ' (showing 200)' : ''}:\n${JSON.stringify(rows, null, 2)}`;
      return { content: [{ type: 'text', text }] };
    } catch (e: unknown) {
      return { content: [{ type: 'text', text: `Query failed: ${(e as Error).message}` }] };
    } finally {
      await client.end().catch(() => undefined);
    }
  },
);

// ---------------------------------------------------------------------------
// Start (stdio transport for Claude Code)
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);

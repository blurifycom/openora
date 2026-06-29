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

const ADDONS_DIR = ['packages', 'addons'] as const;

/** Map add-on id -> 'core' | 'addon', parsed from extensions.config.ts. */
function readAddonKinds(): Map<string, string> {
  const src = readFile(repoPath('extensions.config.ts'));
  const out = new Map<string, string>();
  for (const m of src.matchAll(/\{[^}]*id:\s*'([^']+)'[^}]*\}/g)) {
    out.set(m[1]!, /kind:\s*'addon'/.test(m[0]!) ? 'addon' : 'core');
  }
  return out;
}

/** Resolve an add-on's source dir by name. */
function findModuleDir(name: string): string | null {
  const dir = repoPath(...ADDONS_DIR, name);
  return existsSync(dir) ? dir : null;
}

/** Every add-on package with a plugin.ts. */
function listAllModules(): Array<{ group: string; name: string; dir: string }> {
  const kinds = readAddonKinds();
  const out: Array<{ group: string; name: string; dir: string }> = [];
  for (const name of listDirs(repoPath(...ADDONS_DIR))) {
    const dir = repoPath(...ADDONS_DIR, name);
    if (existsSync(join(dir, 'src', 'plugin.ts'))) {
      out.push({ group: kinds.get(name) ?? 'core', name, dir });
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
  return process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/oss_igaming';
}

const READONLY_SQL_PREFIXES = ['select', 'with', 'explain', 'show', 'table', 'values'];

type IntentKind = 'feature' | 'adapter' | 'ui-page' | 'route' | 'downstream-app' | 'unsure';

/** Best-effort keyword classification of a fuzzy "what I want to build" ask. */
function classifyIntent(ask: string): IntentKind {
  const a = ` ${ask.toLowerCase()} `;
  const has = (re: RegExp) => re.test(a);
  if (
    has(
      /\b(downstream|consumer repo|new project|new app|new repo|my own|standalone|bootstrap|spin up)\b/,
    )
  )
    return 'downstream-app';
  if (
    has(
      /\b(payment|psp|stripe|adyen|kyc|onfido|identity check|sms|email|notification|vendor|adapter|gateway|provider integration)\b/,
    )
  )
    return 'adapter';
  if (has(/\b(page|screen|dashboard|view|frontend|admin panel|backoffice page|player page)\b/))
    return 'ui-page';
  if (has(/\b(endpoint|route|procedure|api method|rpc)\b/)) return 'route';
  if (
    has(
      /\b(module|feature|domain|tournament|leaderboard|jackpot|loyalty|bonus|cashback|mission|quest|reward|system)\b/,
    )
  )
    return 'feature';
  return 'unsure';
}

/** Symbol DI tokens exported from @blurifycom/core/contracts - the vendor swap seams. */
function readAdapterTokens(): string[] {
  const dir = repoPath('packages', 'contracts', 'adapters', 'src');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f === 'index.ts') continue;
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(
      /^export const (\w+)(?::\s*Token<[^>]*>)?\s*=\s*(?:createToken|Symbol)/gm,
    )) {
      out.push(m[1]!);
    }
  }
  return out;
}

/** Named UI slot identifiers - the platform is headless; slots live in the consumer frontend. */
function readSlots(): string[] {
  return [];
}

/** Per-kind step-by-step playbook, grounded in live repo state. */
function buildPlaybook(
  kind: IntentKind,
  ctx: { modules: string[]; tokens: string[]; slots: string[] },
): string {
  const moduleList = ctx.modules.length
    ? ctx.modules.map((m) => `- ${m}`).join('\n')
    : '- (none yet)';
  switch (kind) {
    case 'feature':
      return [
        '## Where it goes',
        'A new business domain -> a new standalone @blurifycom-addons/<name> package under `packages/addons/<name>/` (registered as a core add-on in extensions.config.ts).',
        '',
        '## Existing modules (avoid name collisions)',
        moduleList,
        '',
        '## Playbook',
        '1. Delegate to the `expert` agent: turn this ask into requirements + acceptance criteria (player lifecycle, edge cases, regulatory).',
        '2. Pick a group + kebab-case name. Call `propose-table-change` for every table name you intend to add.',
        '3. Run `scaffold-module <group> <name>` (MCP tool). In a consumer repo, an overlay is `pnpm gen plugin` instead.',
        '4. Fill the `// AGENT: implement here` regions: src/schema (pgTable), src/schemas (Zod), src/service, src/router. Leave the wiring alone.',
        '5. Add routes with `scaffold-route <module> <METHOD> <path>`. Admin routes MUST `await this.adminGuard.assert(context)` first.',
        '6. Run `regen` (drizzle migration + OpenAPI + SDK + catalog), then `run-verify`.',
        '7. Hand the build to `module-author` (or `dev`) with the spec from step 1.',
      ].join('\n');
    case 'adapter':
      return [
        '## Where it goes',
        'A third-party integration -> implement the adapter interface under `packages/addons/<name>/src/adapters/<vendor>/` and bind it to a DI token in the add-on/overlay `plugin.ts`. Interfaces + tokens all live in `@blurifycom/core/contracts`.',
        '',
        '## Adapter tokens available to override',
        ctx.tokens.length ? ctx.tokens.map((t) => `- ${t}`).join('\n') : '- (none found)',
        '',
        '## Playbook',
        '1. Confirm which token from the list above this vendor implements (eg PAYMENT_ADAPTER).',
        '2. Run `scaffold-plugin <vendor>-<category>` (or in a consumer: `pnpm gen adapter`).',
        '3. Implement the interface, then bind your impl to the token in `register(ctx)`. Ensure the overlay loads AFTER the default-binding module in extensions.config.ts (last registration wins).',
        '4. Never inline fetch/axios - all vendor calls go through the adapter.',
        '5. Run `run-verify`. Delegate the build to the `plugin-author` agent.',
      ].join('\n');
    case 'ui-page':
      return [
        '## Where it goes',
        'The platform is headless and ships no UI - pages live in your own frontend repo and consume the api via `@blurifycom/core/react`. The frontend owns all components and styling.',
        '',
        '## Playbook',
        '1. Implement the page in your frontend repo using `@blurifycom/core/react` data hooks.',
        '2. To extend an existing surface without forking it, fill a named slot via your frontend UI plugin (ADR-0006).',
        '3. Run `run-verify`. Delegate backend routes to `dev`.',
      ].join('\n');
    case 'route':
      return [
        '## Where it goes',
        "Add to the owning module's `src/router/index.ts`. Do not define ad-hoc Zod - import from the module `schemas/` or add to `shared-schemas`.",
        '',
        '## Existing modules',
        moduleList,
        '',
        '## Playbook',
        '1. Call `query-openapi <keyword>` first to confirm the route does not already exist.',
        '2. Run `scaffold-route <module> <METHOD> <path>`.',
        '3. Player routes resolve the caller from the verified better-auth session (getUserId); admin routes MUST assert AdminGuard as the first line.',
        '4. Run `regen` then `run-verify`.',
      ].join('\n');
    case 'downstream-app':
      return [
        '## Where it goes',
        'A brand-new operator repo that consumes `@blurifycom/*` via local `link:` - it does NOT fork this repo.',
        '',
        '## Playbook',
        '1. Run `scaffold-app <target-dir>` (MCP tool) or `pnpm create:app ../<name> --name <name>`.',
        '2. In the new dir: `pnpm install && pnpm build:oss && cp .env.example .env` (set DATABASE_URL + AUTH_SECRET) then `pnpm db:migrate`.',
        '3. Run `pnpm setup:mcp` in the new repo so its own agents get this same toolbelt, then `/start` there.',
        '4. `pnpm dev` boots api :3001. The frontend lives in your own repo consuming `@blurifycom/core/react`.',
      ].join('\n');
    default:
      return [
        '## Not sure yet',
        'Ask the user one clarifying question to map the ask onto one of: feature (new module), adapter (vendor swap), ui-page, route, or downstream-app. Then re-run `enhance-intent` with the chosen `kind`.',
        '',
        '## What already exists (for grounding)',
        `Modules: ${ctx.modules.join(', ') || '(none)'}`,
        `Adapter tokens: ${ctx.tokens.join(', ') || '(none)'}`,
      ].join('\n');
  }
}

/**
 * The requirements interview. The human answers these; the agent does everything
 * after. Shared by `start` and `enhance-intent` so requirements-first holds
 * regardless of entry point.
 */
const REQUIREMENTS_INTERVIEW = [
  'Interview the user with AskUserQuestion in small batches (2-4 questions at a time). Adapt to their answers, dig into anything vague, and keep going until you could hand a stranger a spec they could build from. Cover what applies - skip what does not:',
  '',
  '- Goal: what player or operator problem does this solve? what is the desired outcome?',
  '- Actors: who uses it - players, backoffice admins, affiliates, support?',
  '- Trigger: when/how does it start - user action, schedule, event, deposit, game round?',
  '- Data: what does it track? what entities/records/fields?',
  '- Value flow: does it move money, bonus credits, points, or free spins? which currency? get the exact amounts/rates.',
  '- Rules: eligibility, limits, caps, wagering requirements, cooldowns, expiry?',
  '- Lifecycle: what states does the entity move through (eg pending -> active -> settled -> expired)?',
  '- Compliance: any regulatory or responsible-gaming angle? which jurisdictions/markets?',
  '- UI: player-facing, backoffice, or both? what does each audience see and do?',
  '- Edge cases: failure, partial completion, concurrency, refunds/reversals, abuse?',
  '- Success criteria: how will the user know it works? what must be true?',
  '- Out of scope: what is explicitly NOT part of this?',
  '',
  'Then summarize the requirements back to the user as a short structured list and get an explicit yes before any building starts.',
].join('\n');

const server = new McpServer({
  name: 'oss-dev',
  version: '0.1.0',
});

server.registerTool(
  'read-agents-md',
  {
    description: 'Read a section of AGENTS.md (or a package-level AGENTS.md) by heading name.',
    inputSchema: {
      section: z.string().optional().describe('H2 heading to read (omit for the full file)'),
      package: z
        .string()
        .optional()
        .describe('Package name or path relative to repo root (omit for root AGENTS.md)'),
    },
  },
  async ({ section, package: pkg }) => {
    const filePath = pkg
      ? repoPath(pkg.replace(/^@blurifycom\//, ''), 'AGENTS.md')
      : repoPath('AGENTS.md');
    const content = readFile(filePath);
    if (!content) return { content: [{ type: 'text', text: `No AGENTS.md found at ${filePath}` }] };
    const text = section
      ? parseAgentsMdSection(content, section) || `Section "${section}" not found.`
      : content;
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'list-modules',
  {
    description: 'List all registered modules/extensions from extensions.config.ts.',
    inputSchema: {},
  },
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

server.registerTool(
  'describe-module',
  {
    description:
      'Everything you need to edit a module in one call: its AGENTS.md, Drizzle tables, Zod schemas, and router surface. Prefer this over reading the files individually.',
    inputSchema: {
      name: z.string().describe('Module name (kebab-case)'),
      response_format: z
        .enum(['concise', 'detailed'])
        .optional()
        .describe(
          'concise (default): AGENTS.md + table/schema/route names only. detailed: full source of every file.',
        ),
    },
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
    const parts: string[] = [
      `=== Module: ${name} ===\n`,
      readFile(join(dir, 'AGENTS.md')) || '(no AGENTS.md)',
    ];

    if (detailed) {
      parts.push('\n--- Drizzle tables (src/schema/index.ts) ---', schemaSrc || '(no tables)');
      parts.push('\n--- Zod schemas (src/schemas/index.ts) ---', zodSrc || '(empty)');
      parts.push('\n--- Router ---', routerSrc || '(empty)');
    } else {
      const tables = [...schemaSrc.matchAll(/pgTable\(\s*'([^']+)'/g)].map((m) => m[1]);
      const zods = [...zodSrc.matchAll(/export const (\w+Schema)\b/g)].map((m) => m[1]);
      const routes = [...routerSrc.matchAll(/^\s{2,}(\w+):\s*os\b/gm)].map(
        (m) => `${name}.${m[1]}`,
      );
      parts.push(`\n--- Tables ---\n${tables.join(', ') || '(none)'}`);
      parts.push(`\n--- Schemas ---\n${zods.join(', ') || '(none)'}`);
      parts.push(`\n--- Routes ---\n${routes.join(', ') || '(none)'}`);
      parts.push('\n(Pass response_format: "detailed" for full source.)');
    }

    return { content: [{ type: 'text', text: parts.join('\n') }] };
  },
);

server.registerTool(
  'list-routes',
  {
    description: 'List all oRPC route namespaces across modules. Pass module name to filter.',
    inputSchema: { module: z.string().optional() },
  },
  async ({ module: mod }) => {
    const all = listAllModules();
    const modules = mod ? all.filter((m) => m.name === mod) : all;
    const lines: string[] = [];
    for (const { name, dir } of modules) {
      const routerFile = join(dir, 'src', 'router', 'index.ts');
      if (!existsSync(routerFile)) continue;
      const src = readFileSync(routerFile, 'utf8');
      const procedures = [...src.matchAll(/^\s{2,}(\w+):\s*os\b/gm)].map(
        (m) => `  ${name}.${m[1]}`,
      );
      if (procedures.length > 0) lines.push(`${name}:\n${procedures.join('\n')}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n\n') || 'No routes defined yet.' }] };
  },
);

server.registerTool(
  'list-extension-points',
  {
    description:
      'List the exported event types and port interfaces (adapter swap seams) across the platform.',
    inputSchema: {},
  },
  async () => {
    const parts: string[] = [];

    const eventsFile = repoPath('packages', 'platform', 'core', 'src', 'event-bus.ts');
    if (existsSync(eventsFile)) {
      parts.push(
        `\n=== Events (EventBus from @blurifycom/core/server) ===\n${readFile(eventsFile)}`,
      );
    } else {
      parts.push('\n=== Events ===\n(event-bus.ts not found)');
    }

    const adaptersDir = repoPath('packages', 'contracts', 'adapters', 'src');
    parts.push('\n=== Adapter interfaces (@blurifycom/core/contracts) ===');
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

server.registerTool(
  'query-openapi',
  {
    description: 'Search the generated OpenAPI spec for paths or operations matching a keyword.',
    inputSchema: { keyword: z.string() },
  },
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

server.registerTool(
  'scaffold-module',
  {
    description:
      'Scaffold a new business module as a standalone @blurifycom-addons/<name> package under packages/addons/<name>.',
    inputSchema: {
      group: z.enum(['player', 'backoffice', 'platform']),
      name: z.string(),
    },
  },
  async ({ group, name }) => {
    const result = run(`pnpm gen module ${group} ${name}`);
    return {
      content: [{ type: 'text', text: result.output || (result.ok ? 'Done.' : 'Failed.') }],
    };
  },
);

server.registerTool(
  'scaffold-plugin',
  {
    description: 'Scaffold a new overlay extension under extensions/<name>.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const result = run(`pnpm gen plugin ${name}`);
    return {
      content: [{ type: 'text', text: result.output || (result.ok ? 'Done.' : 'Failed.') }],
    };
  },
);

server.registerTool(
  'scaffold-route',
  {
    description: 'Add an oRPC route stub to a module',
    inputSchema: {
      module: z.string(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string(),
    },
  },
  async ({ module: mod, method, path }) => {
    const result = run(`pnpm gen route ${mod} ${method} ${path}`);
    return {
      content: [{ type: 'text', text: result.output || (result.ok ? 'Done.' : 'Failed.') }],
    };
  },
);

server.registerTool(
  'scaffold-app',
  {
    description:
      'Bootstrap a new downstream igaming consumer repo (api + web + backoffice) wired to this OSS checkout via link:. Delegates to tools/create-igaming-app.ts. Does NOT run pnpm install - tell the user to run `pnpm install && pnpm build:oss && pnpm db:migrate` in the new dir next.',
    inputSchema: {
      target: z
        .string()
        .describe(
          'Target directory for the new repo, relative to this OSS checkout root, e.g. "../my-igaming".',
        ),
      name: z.string().optional().describe('Project name. Defaults to the target dir basename.'),
    },
  },
  async ({ target, name }) => {
    const nameFlag = name ? ` --name ${name}` : '';
    const result = run(`pnpm create:app ${target}${nameFlag}`);
    return {
      content: [{ type: 'text', text: result.output || (result.ok ? 'Done.' : 'Failed.') }],
    };
  },
);

server.registerTool(
  'run-verify',
  {
    description:
      'Run pnpm verify (typecheck + lint + unit tests). Pass filter to scope to one package.',
    inputSchema: { filter: z.string().optional() },
  },
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

server.registerTool(
  'regen',
  {
    description:
      'Run pnpm regen: drizzle-kit generate (migrations from pgTable schemas) + emit OpenAPI spec + regenerate the typed SDK.',
    inputSchema: {},
  },
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

server.registerTool(
  'get-drizzle-schema',
  {
    description:
      'Return the Drizzle table definitions (pgTable) across all modules. Pass a module name to scope to one. Source of truth for the DB shape - read this instead of grepping schema files.',
    inputSchema: {
      module: z.string().optional().describe('Module name (kebab-case) to scope to'),
      response_format: z
        .enum(['concise', 'detailed'])
        .optional()
        .describe('concise (default): table names + columns. detailed: full pgTable source.'),
    },
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
        const summary = tables.map(
          ([, constName, tableName]) => `  ${constName} -> '${tableName}'`,
        );
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

server.registerTool(
  'propose-table-change',
  {
    description:
      'Check a proposed Drizzle table name for collisions across all module schemas before you add a pgTable. Returns [OK] or [COLLISION] with the owning module.',
    inputSchema: { table: z.string().describe("snake_case pgTable name, e.g. 'tournament_entry'") },
  },
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
                text: `[COLLISION] Table '${want}' already defined in packages/addons/${name}/src/schema/index.ts (${group} add-on). Pick a different name or add a column to the existing table.`,
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

server.registerTool(
  'schema-get',
  {
    description:
      'Find a Zod domain schema by name and return its definition with file location. Searches packages/contracts/*.',
    inputSchema: {
      name: z.string().describe('Schema name, e.g. "WalletBalance" or "WalletBalanceSchema"'),
    },
  },
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

server.registerTool(
  'docs-search',
  {
    description:
      'Search markdown docs (docs/, README, AGENTS.md, ADRs, per-package AGENTS.md) for a keyword. Returns matching lines with locations.',
    inputSchema: {
      query: z.string().describe('Case-insensitive substring to search for'),
      limit: z.number().optional().describe('Max matching lines to return (default 60)'),
    },
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

server.registerTool(
  'db-query-readonly',
  {
    description:
      'Run a read-only SQL query against the dev database (wrapped in a READ ONLY transaction). Only SELECT/WITH/EXPLAIN/SHOW/TABLE/VALUES are allowed; results capped at 200 rows.',
    inputSchema: { sql: z.string().describe('A single read-only SQL statement') },
  },
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

server.registerTool(
  'list-slash-commands',
  {
    description:
      'List all available slash commands (scaffold shortcuts) with their one-line descriptions. These are repo-local commands generated by rulesync into .claude/commands/ (source: .rulesync/commands/); other editors can invoke the equivalent MCP scaffold tools directly.',
    inputSchema: {},
  },
  async () => {
    const commandsDir = join(repoRoot, '.claude', 'commands');
    if (!existsSync(commandsDir))
      return { content: [{ type: 'text', text: 'No .claude/commands/ directory found.' }] };
    const lines: string[] = ['Available slash commands:\n'];
    for (const file of readdirSync(commandsDir).sort()) {
      if (!file.endsWith('.md')) continue;
      const name = '/' + file.replace(/\.md$/, '');
      const content = readFileSync(join(commandsDir, file), 'utf8');
      const descLine = content.split('\n').find((l) => l.startsWith('description:'));
      const desc = descLine
        ? descLine
            .slice('description:'.length)
            .trim()
            .replace(/^["']|["']$/g, '')
        : '';
      lines.push(`  ${name.padEnd(28)} ${desc}`);
    }
    lines.push('\nNote: use the MCP scaffold-* tools to invoke these from any editor.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.registerTool(
  'enhance-intent',
  {
    description:
      'Turn a fuzzy "what I want to build" ask into a grounded, structured brief. Classifies the intent against the platform decision tree, injects LIVE repo context (existing modules, adapter tokens, UI slots), and returns an exact step-by-step playbook (which scaffold-* tool to run, which agent to delegate to, propose-table-change + run-verify reminders) plus an acceptance-criteria stub. Call this from the /start onboarding flow, or any time a user describes a feature in vague terms.',
    inputSchema: {
      ask: z
        .string()
        .describe(
          "The user's raw request in their own words, eg 'add a tournaments feature with leaderboards and prize payouts'",
        ),
      kind: z
        .enum(['feature', 'adapter', 'ui-page', 'route', 'downstream-app', 'unsure'])
        .optional()
        .describe('Override the auto-classification if you already know the kind of work.'),
    },
  },
  async ({ ask, kind }) => {
    const resolved = kind && kind !== 'unsure' ? kind : classifyIntent(ask);
    const ctx = {
      modules: listAllModules().map((m) => `${m.group}/${m.name}`),
      tokens: readAdapterTokens(),
      slots: readSlots(),
    };
    const tree = parseAgentsMdSection(
      readFile(repoPath('AGENTS.md')),
      'Where does X go? (decision tree)',
    );
    const detected = kind && kind !== 'unsure' ? '' : ' (auto-detected - correct me if wrong)';

    const text = [
      '# Enhanced brief',
      '',
      '## Restated intent',
      `> ${ask.trim()}`,
      '',
      `## Classification: ${resolved}${detected}`,
      '',
      '## Requirements - collect these from the user FIRST (if not already gathered)',
      'A one-line ask is a starting point, not a spec. Your main job is to gather thorough requirements; delegate the build to the agents.',
      '',
      REQUIREMENTS_INTERVIEW,
      '',
      buildPlaybook(resolved, ctx),
      '',
      '## Acceptance criteria (derive from the requirements above)',
      '- [ ] Happy path works end to end',
      '- [ ] Edge cases and failure modes handled',
      '- [ ] `pnpm verify` is green (typecheck + lint + boundaries + tests)',
      '',
      '## Decision-tree reference (from AGENTS.md)',
      tree || '(decision tree section not found)',
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'dev:infra',
  {
    description:
      'Start (or stop/status) the local dev infrastructure via docker compose. Boots postgres on :5432. Call this before pnpm dev or pnpm db:migrate when the database is not reachable.',
    inputSchema: {
      action: z
        .enum(['up', 'down', 'status'])
        .optional()
        .describe(
          'up (default): start containers detached. down: stop and remove. status: show running containers.',
        ),
    },
  },
  async ({ action = 'up' }) => {
    if (action === 'status') {
      const r = run('docker compose ps');
      return { content: [{ type: 'text', text: r.output || '(no output)' }] };
    }

    if (action === 'down') {
      const r = run('docker compose down');
      return { content: [{ type: 'text', text: r.ok ? 'Stopped.' : r.output }] };
    }

    const up = run('docker compose up -d');
    if (!up.ok) {
      return { content: [{ type: 'text', text: `docker compose up failed:\n${up.output}` }] };
    }

    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = run('docker compose exec -T postgres pg_isready -U postgres');
      if (probe.ok) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }

    const text = ready
      ? `Postgres is ready on :5432.\n\nNext: pnpm db:migrate (apply schema) then pnpm dev.`
      : `Containers started but postgres did not become ready within 30 s.\nRun \`docker compose logs postgres\` to investigate.`;
    return { content: [{ type: 'text', text: text }] };
  },
);

server.registerTool(
  'start',
  {
    description:
      'Onboarding entry point. Call this when the user opens Claude Code in a fresh consumer repo, says "start", "help me build X", or asks what they can do. Returns a structured onboarding script: questions to ask, options to present, and what to do with the answers. Follow the script exactly - ask the questions via AskUserQuestion, then call enhance-intent with the result.',
    inputSchema: {
      ask: z
        .string()
        .optional()
        .describe(
          "Pass the user's raw ask if they already described what they want to build. Omit to get the full interactive onboarding flow.",
        ),
    },
  },
  async ({ ask }) => {
    const modules = listAllModules().map((m) => `${m.group}/${m.name}`);
    const tokens = readAdapterTokens();

    const role = [
      '## Your role',
      'You are a requirements interviewer and orchestrator. Your one human-facing job is to collect thorough requirements from the user. Everything after - scaffolding, code, tests - you delegate to the agents (`expert` for requirements + AC, `module-author` / `dev` to build, `qa` to test) via the Task tool. Keep the user out of the loop after requirements are confirmed, except for genuine decisions only they can make.',
    ].join('\n');

    if (ask) {
      const resolved = classifyIntent(ask);
      const playbook = buildPlaybook(resolved, { modules, tokens, slots: readSlots() });
      const text = [
        '# Onboarding',
        `The user opened with: **${ask}**  (looks like: ${resolved})`,
        '',
        role,
        '',
        '## Step 1: gather requirements (the important part)',
        'That opening line is a starting point, not a spec. Interview the user now:',
        '',
        REQUIREMENTS_INTERVIEW,
        '',
        '## Step 2: delegate everything',
        'Once requirements are confirmed, call `enhance-intent` (ask = the confirmed requirements summary, kind = the detected kind), then follow its playbook - which hands the work to the agents. Do not implement directly.',
        '',
        playbook,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }

    const text = [
      '# Onboarding script - follow this exactly',
      '',
      role,
      '',
      '## Step 1: high-level intent (AskUserQuestion, single-select)',
      'Present AT MOST 4 options - AskUserQuestion rejects more, and it auto-adds an "Other" for anything else. This only routes the playbook, so keep it light:',
      'Question: "What do you want to build?"',
      '- New feature / business module (tournaments, loyalty, jackpots) -> kind: feature',
      '- Swap a vendor adapter (payment / KYC / notifications) -> kind: adapter',
      '- Add a UI page (player app or backoffice) -> kind: ui-page',
      '- Something else (a single route, a new downstream app, or not sure) -> kind: unsure',
      'Map the free-text answer to feature | adapter | ui-page | route | downstream-app | unsure for enhance-intent (route and downstream-app are valid kinds even though they are not top-level options).',
      '',
      '## Step 2: requirements interview (spend most of your effort here)',
      REQUIREMENTS_INTERVIEW,
      '',
      '## Step 3: delegate everything',
      'Call `enhance-intent` (ask = the confirmed requirements summary, kind = step 1). Then follow its playbook, which delegates to the agents. You orchestrate; you do not write feature code yourself.',
      '',
      '## Platform context (for your reference)',
      `Existing modules: ${modules.join(', ') || '(none yet)'}`,
      `Adapter tokens: ${tokens.join(', ') || '(none)'}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

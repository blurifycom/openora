import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDepGraph, impactOf, type DepGraph } from './dep-graph.js';
import { classifyIntent, type IntentKind } from './intent.js';
import {
  findCoreSourceRoot,
  findSymbol,
  findUsages,
  outline,
  readSourceTree,
  type SourceFile,
  LINE_WIDTH,
} from './source.js';

const here = dirname(fileURLToPath(import.meta.url));
const ownPackage: { version: string } = JSON.parse(
  readFileSync(join(here, '..', 'package.json'), 'utf8'),
);

type CatalogModule = {
  id: string;
  group: string;
  tables: string[];
  routes: string[];
};

type CatalogAdapter = {
  category: string;
  interface: string;
  methods?: string[];
  token: string;
  status: string;
  boundIn: string[];
};

const formatMethods = (a: CatalogAdapter): string =>
  a.methods?.length ? ` { ${a.methods.join(', ')} }` : '';

type CatalogSchema = {
  name: string;
  file: string;
};

type CatalogConfigField = {
  key: string;
  note: string;
};

type CatalogConfig = {
  token: string;
  source: string;
  fields: CatalogConfigField[];
};

type CatalogAgentIam = { resource: string; action: string };

type CatalogAgentTool = {
  id: string;
  module: string;
  file: string;
  title: string | null;
  description: string | null;
  class: string | null;
  schemaVersion: number | null;
  iam: CatalogAgentIam | null;
};

type CatalogAgentAction = {
  id: string;
  module: string;
  file: string;
  title: string | null;
  description: string | null;
  schemaVersion: number | null;
  iam: CatalogAgentIam | null;
  reversible: boolean | null;
  benefitsPlayer?: boolean | null;
  benefitsPlayerWhen?: { field: string; values: string[] } | null;
  distinctBy?: string | null;
};

type Catalog = {
  modules: CatalogModule[];
  adapters: CatalogAdapter[];
  events: string[];
  schemas: CatalogSchema[];
  config: CatalogConfig;
  pluginContract: string[];
  agentTools?: CatalogAgentTool[];
  agentActions?: CatalogAgentAction[];
};

const formatIam = (iam: CatalogAgentIam | null) =>
  iam ? `${iam.resource}:${iam.action}` : '(non-literal)';

function formatAgentTool(t: CatalogAgentTool): string[] {
  return [
    `- ${t.id}  [${t.class ?? '?'}, v${t.schemaVersion ?? '?'}, iam ${formatIam(t.iam)}, module ${t.module}]`,
    ...(t.title || t.description
      ? [`    ${[t.title, t.description].filter(Boolean).join(' - ')}`]
      : []),
  ];
}

function formatAgentAction(a: CatalogAgentAction): string[] {
  const reversibility =
    a.reversible === null ? 'reversible ?' : a.reversible ? 'reversible' : 'irreversible';
  const benefit =
    a.benefitsPlayer === null
      ? ', benefits player ?'
      : a.benefitsPlayer
        ? ', benefits player'
        : a.benefitsPlayerWhen
          ? `, benefits player when ${a.benefitsPlayerWhen.field} is ${a.benefitsPlayerWhen.values.join(' or ')}`
          : '';
  const distinct = a.distinctBy ? `, distinct by ${a.distinctBy}` : '';
  return [
    `- ${a.id}  [${reversibility}${benefit}${distinct}, v${a.schemaVersion ?? '?'}, iam ${formatIam(a.iam)}, module ${a.module}]`,
    ...(a.title || a.description
      ? [`    ${[a.title, a.description].filter(Boolean).join(' - ')}`]
      : []),
  ];
}

const containsIgnoreCase = (query: string, ...fields: string[]): boolean =>
  fields.some((f) => f.toLowerCase().includes(query.toLowerCase()));

function bindingPlugins(a: CatalogAdapter): string[] {
  return a.boundIn
    .filter((p) => p.endsWith('/plugin.ts'))
    .map((p) => p.replace(/^packages\/core\/src\//, '').replace(/\/plugin\.ts$/, ''));
}

function formatAdapter(a: CatalogAdapter): string {
  const plugins = bindingPlugins(a);
  const bound =
    plugins.length > 0
      ? `bound in ${plugins.join(', ')}`
      : a.status === 'wired'
        ? 'bound in the core runtime'
        : 'stub - bind your implementation';
  return `- ${a.category}: ${a.interface}${formatMethods(a)} -> ${a.token}  [${a.status}; ${bound}]`;
}

const SCHEMA_MATCH_LIMIT = 30;

const NOT_FOUND_MESSAGE =
  'catalog.json not found - run `pnpm regen` in the platform repo, or set OSS_CATALOG to its path.';

function catalogCandidates(): string[] {
  const candidates: string[] = [];

  const override = process.env['OSS_CATALOG'];
  if (override) {
    candidates.push(override);
  }

  const cwd = process.cwd();

  candidates.push(join(cwd, 'docs', 'catalog.json'));
  candidates.push(join(cwd, 'node_modules', '@openora', 'mcp', 'docs', 'catalog.json'));

  let dir = cwd;
  for (;;) {
    candidates.push(join(dir, 'docs', 'catalog.json'));
    const parent = parse(dir).dir;
    if (!parent || parent === dir) {
      break;
    }
    dir = parent;
  }

  candidates.push(join(here, '..', 'docs', 'catalog.json'));

  return candidates;
}

function loadCatalog(): { catalog: Catalog; path: string } | null {
  for (const candidate of catalogCandidates()) {
    if (!candidate || !existsSync(candidate)) {
      continue;
    }
    try {
      const catalog = JSON.parse(readFileSync(candidate, 'utf8')) as Catalog;
      return { catalog, path: candidate };
    } catch {
      continue;
    }
  }
  return null;
}

function withCatalog(fn: (catalog: Catalog) => string) {
  return async () => {
    const loaded = loadCatalog();
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    }
    return { content: [{ type: 'text' as const, text: fn(loaded.catalog) }] };
  };
}

const server = new McpServer({
  name: 'oss',
  version: ownPackage.version,
});

server.registerTool(
  'catalog-overview',
  {
    description:
      'START HERE. A concise "what can I extend" summary of the OSS igaming platform you are consuming: counts of modules/events/schemas, the adapter swap-seam table (category/interface/token/status), and the igaming-config fields. Read this first to orient before drilling into the other tools.',
    inputSchema: {},
  },
  withCatalog((c) => {
    const lines: string[] = ['=== OSS igaming platform catalog ==='];
    lines.push(
      `modules: ${c.modules.length}  adapters: ${c.adapters.length}  events: ${c.events.length}  ` +
        `schemas: ${c.schemas.length}  agent tools: ${c.agentTools?.length ?? 0}  ` +
        `action types: ${c.agentActions?.length ?? 0}`,
    );

    const stubs = c.adapters.filter((a) => a.status !== 'wired').map((a) => a.category);
    lines.push('\n--- Adapter seams (details: list-adapters <query>) ---');
    lines.push(c.adapters.map((a) => a.category).join(', '));
    lines.push(`stubs awaiting an implementation: ${stubs.join(', ') || '(none)'}`);
    lines.push(`\n--- Modules (details: describe-module <id>) ---`);
    lines.push(c.modules.map((m) => m.id).join(', '));

    lines.push(`\n--- Config (${c.config.token}) ---`);
    for (const f of c.config.fields) {
      lines.push(`- ${f.key}${f.note ? `: ${f.note}` : ''}`);
    }

    lines.push(
      '\nNext: list-adapters | list-routes | list-events | list-agent-tools | describe-module <name> | schema-get <name> | get-config-schema',
    );
    return lines.join('\n');
  }),
);

server.registerTool(
  'list-adapters',
  {
    description:
      'List the vendor adapter swap-seams (PSP/KYC/game/aggregator/geo-ip/notification). For each: the interface to implement, the DI token to bind it to, whether it is already wired or a stub awaiting an implementation, and which module plugins bind it. Use this to find the integration point for a third-party vendor. Pass `query` (e.g. "withdrawal", "kyc") to keep the output short.',
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Case-insensitive filter on category, interface, token or binding module'),
    },
  },
  async ({ query }) => {
    const loaded = loadCatalog();
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    }
    const adapters = loaded.catalog.adapters.filter(
      (a) =>
        !query ||
        containsIgnoreCase(
          query,
          a.category,
          a.interface,
          a.token,
          ...(a.methods ?? []),
          ...bindingPlugins(a),
        ),
    );
    const text =
      adapters.length > 0
        ? `=== Adapter seams (${adapters.length}) ===\n${adapters.map(formatAdapter).join('\n')}`
        : `No adapter seam matches "${query}".`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.registerTool(
  'list-routes',
  {
    description:
      'List oRPC route namespaces exposed by the platform modules. Pass `module` to scope to a single module and `query` (e.g. "withdraw") to keep only matching routes.',
    inputSchema: {
      module: z.string().optional().describe('Module id to filter by (e.g. "wallet")'),
      query: z.string().optional().describe('Case-insensitive substring of the route'),
    },
  },
  async ({ module: mod, query }) => {
    const loaded = loadCatalog();
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    }
    const c = loaded.catalog;
    const modules = mod ? c.modules.filter((m) => m.id === mod) : c.modules;
    if (mod && modules.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Module "${mod}" not found. Run catalog-overview to see module ids.`,
          },
        ],
      };
    }
    const lines: string[] = [];
    for (const m of modules) {
      const routes = m.routes.filter((r) => !query || containsIgnoreCase(query, r));
      if (routes.length > 0) {
        lines.push(`${m.id}:\n${routes.map((r) => `  ${r}`).join('\n')}`);
      }
    }
    const text =
      lines.join('\n\n') ||
      (query ? `No route matches "${query}".` : 'No routes defined in the catalog yet.');
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.registerTool(
  'list-events',
  {
    description:
      'List the cross-module domain events you can subscribe to (via ctx.events.on in a plugin) or that signal platform activity. Use this to find the event to hook into for side effects. Pass `query` (e.g. "withdrawal", "promo.bonus") to keep the output short.',
    inputSchema: {
      query: z.string().optional().describe('Case-insensitive substring of the event name'),
    },
  },
  async ({ query }) => {
    const loaded = loadCatalog();
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    }
    const events = loaded.catalog.events.filter((e) => !query || containsIgnoreCase(query, e));
    const text =
      events.length > 0
        ? `=== Domain events (${events.length}) ===\n${events.map((e) => `- ${e}`).join('\n')}`
        : `No event matches "${query}".`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.registerTool(
  'list-agent-tools',
  {
    description:
      'List the agent surface: MCP tools (read calls a model may make during a run) and action types (state changes a model may only propose; an idempotent executor runs them after approval). Each entry shows its IAM resource:action, schema version and owning module. Modules register them in plugin.ts with ctx.mcp.tool(defineMcpTool({...}), factory) and ctx.actions.register(defineActionType({...}), factory); consumers reach them only through the MCP_KERNEL token, which validates input, checks IAM, applies the output allow-list and audits every call. Pass `module` to scope to one module and `query` to match ids, titles and descriptions.',
    inputSchema: {
      module: z.string().optional().describe('Module id to filter by (e.g. "wallet")'),
      query: z
        .string()
        .optional()
        .describe('Case-insensitive substring of the id, title or description'),
    },
  },
  async ({ module: mod, query }) => {
    const loaded = loadCatalog();
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    }
    const c = loaded.catalog;
    const matches = (e: CatalogAgentTool | CatalogAgentAction) =>
      (!mod || e.module === mod) &&
      (!query || containsIgnoreCase(query, e.id, e.title ?? '', e.description ?? ''));
    const tools = (c.agentTools ?? []).filter(matches);
    const actions = (c.agentActions ?? []).filter(matches);
    const lines: string[] = [`=== Agent tools (${tools.length}) ===`];
    lines.push(...(tools.length > 0 ? tools.flatMap(formatAgentTool) : ['(none)']));
    lines.push(`\n=== Agent action types (${actions.length}) ===`);
    lines.push(...(actions.length > 0 ? actions.flatMap(formatAgentAction) : ['(none)']));
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.registerTool(
  'describe-module',
  {
    description:
      "Describe one platform module from the catalog: its group (player/backoffice/platform), Drizzle tables, and oRPC routes. Use this to understand a module's surface before extending or integrating with it.",
    inputSchema: { name: z.string().describe('Module id (e.g. "wallet", "gaming")') },
  },
  async ({ name }) => {
    const loaded = loadCatalog();
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    }
    const c = loaded.catalog;
    const m = c.modules.find((x) => x.id === name);
    if (!m) {
      const ids = c.modules.map((x) => x.id).join(', ');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Module "${name}" not found.\n\nAvailable modules: ${ids}`,
          },
        ],
      };
    }
    const lines: string[] = [`=== Module: ${m.id} (${m.group}) ===`];
    lines.push(
      `\n--- Tables ---\n${m.tables.length > 0 ? m.tables.map((t) => `- ${t}`).join('\n') : '(none)'}`,
    );
    lines.push(
      `\n--- Routes ---\n${m.routes.length > 0 ? m.routes.map((r) => `- ${r}`).join('\n') : '(none)'}`,
    );
    const eventSegments = [m.id, m.id.replaceAll('-', '_')];
    const events = c.events.filter((e) => e.split('.').some((s) => eventSegments.includes(s)));
    lines.push(
      `\n--- Events named after this module ---\n${events.length > 0 ? events.map((e) => `- ${e}`).join('\n') : '(none - try list-events query=<word>)'}`,
    );
    const seams = c.adapters.filter((a) =>
      bindingPlugins(a).some((p) => p === m.id || p.endsWith(`/${m.id}`)),
    );
    if (seams.length > 0) {
      const seamLines = seams.map((a) => `- ${a.category} -> ${a.token}`).join('\n');
      lines.push(
        `\n--- Adapter seams this module binds or reads (methods: list-adapters query=<category>) ---\n${seamLines}`,
      );
    }
    const tools = (c.agentTools ?? []).filter((t) => t.module === m.id);
    const actions = (c.agentActions ?? []).filter((a) => a.module === m.id);
    if (tools.length > 0) {
      lines.push(`\n--- Agent tools ---\n${tools.flatMap(formatAgentTool).join('\n')}`);
    }
    if (actions.length > 0) {
      lines.push(`\n--- Agent action types ---\n${actions.flatMap(formatAgentAction).join('\n')}`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.registerTool(
  'schema-get',
  {
    description:
      'Locate a Zod contract schema by name and return the file that defines it. The actual shape is read from the package types you have installed; this tells you WHERE the schema lives so you can import it.',
    inputSchema: {
      name: z
        .string()
        .min(1)
        .describe('Schema name, e.g. "WalletBalance" or "WalletBalanceSchema"'),
    },
  },
  async ({ name }) => {
    const loaded = loadCatalog();
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    }
    const c = loaded.catalog;
    const candidates = name.endsWith('Schema') ? [name] : [`${name}Schema`, name];
    const hit = c.schemas.find((s) => candidates.includes(s.name));
    if (hit) {
      return { content: [{ type: 'text' as const, text: `${hit.name}\n${hit.file}` }] };
    }
    const close = c.schemas.filter((s) => containsIgnoreCase(name, s.name));
    const shown = close
      .slice(0, SCHEMA_MATCH_LIMIT)
      .map((s) => `- ${s.name}  ${s.file}`)
      .join('\n');
    const more =
      close.length > SCHEMA_MATCH_LIMIT
        ? `\n(${close.length - SCHEMA_MATCH_LIMIT} more - narrow the name)`
        : '';
    const text =
      close.length > 0
        ? `No schema named "${name}". Names containing it:\n${shown}${more}`
        : `No schema name contains "${name}". Try a shorter word (e.g. "Withdraw").`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

const USAGE_LIMIT = 40;
const SYMBOL_LOCATION_LIMIT = 5;
type Source = { root: string; files: SourceFile[] };

function loadSource(): Source | string {
  const loaded = loadCatalog();
  const root = process.env['OSS_SOURCE'] ?? (loaded ? findCoreSourceRoot(loaded.path) : null);
  if (!root || !existsSync(root)) {
    return 'Platform source not found - it is read from a linked platform checkout (packages/core/src). Set OSS_SOURCE to that folder.';
  }
  return { root, files: readSourceTree(root) };
}

const textReply = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const namesInput = (example: string) =>
  z
    .array(z.string().min(2))
    .min(1)
    .max(10)
    .describe(`One or more names, looked up together in one call, e.g. ${example}`);

function usagesOf(source: Source, name: string, mod?: string, includeTests?: boolean): string {
  const usages = findUsages(source.files, name, { module: mod, includeTests });
  if (usages.length === 0) {
    return `No usage of "${name}"${mod ? ` under ${mod}/` : ''}.`;
  }
  const shown = usages.slice(0, USAGE_LIMIT).map((u) => `${u.path}:${u.line}  ${u.text}`);
  const more =
    usages.length > USAGE_LIMIT
      ? `\n(${usages.length - USAGE_LIMIT} more - pass module=<folder> to narrow)`
      : '';
  return `=== ${usages.length} usages of ${name} ===\n${shown.join('\n')}${more}`;
}

server.registerTool(
  'find-usages',
  {
    description:
      'Find where identifiers are used: a DI token (WALLET_COMMANDS), a function, a type, an event or route id. Whole-word match over packages/core/src, comment lines and tests skipped. Returns `file:line  code`, capped. Pass every name you need in one call. Use it instead of grepping the platform source.',
    inputSchema: {
      names: namesInput('["WALLET_COMMANDS", "withdraw"]'),
      module: z
        .string()
        .optional()
        .describe('Only files under this folder, for every name, e.g. "wallet" or "promo/bonus"'),
      includeTests: z.boolean().optional().describe('Also search test files (default false)'),
    },
  },
  async ({ names, module: mod, includeTests }) => {
    const source = loadSource();
    if (typeof source === 'string') {
      return textReply(source);
    }
    const sections = [...new Set(names)].map((name) => usagesOf(source, name, mod, includeTests));
    return textReply([`(paths under ${source.root})`, ...sections].join('\n\n'));
  },
);

function symbolOf(source: Source, name: string, file: string | undefined, maxLines: number) {
  const hits = findSymbol(source.files, name, { file });
  if (hits.length === 0) {
    return `No declaration of "${name}"${file ? ` in files matching ${file}` : ''}. Try find-usages names=["${name.split('.').pop()}"].`;
  }
  if (hits.length > SYMBOL_LOCATION_LIMIT) {
    const where = hits
      .slice(0, USAGE_LIMIT)
      .map((h) => `${h.path}:${h.line}  ${(h.body[0] ?? '').trim().slice(0, LINE_WIDTH)}`);
    if (hits.length > USAGE_LIMIT) {
      where.push(`(${hits.length - USAGE_LIMIT} more)`);
    }
    return `${hits.length} declarations of "${name}" - pass file=<path part>${name.includes('.') ? '' : ` or Owner.${name}`}:\n${where.join('\n')}`;
  }
  return hits
    .map((h) => {
      const path = `${source.root}/${h.path}`;
      const head = `--- ${path}:${h.line}-${h.line + h.body.length - 1} ---`;
      if (h.body.length <= maxLines) {
        return `${head}\n${h.body.map((l) => l.slice(0, LINE_WIDTH)).join('\n')}`;
      }
      const shape = outline(h);
      const shown = shape.slice(0, maxLines).map((l) => l.slice(0, LINE_WIDTH));
      const nextLine = shape[maxLines]?.split(':')[0];
      const rest = nextLine
        ? `${shape.length - maxLines} more outline lines; Read ${path} offset=${nextLine} limit=${h.line + h.body.length - Number(nextLine)} for the rest`
        : `Read ${path} offset=<line> limit=<n> for a part`;
      return [
        `${head} (outline: ${h.body.length} lines is over maxLines=${maxLines})`,
        ...shown,
        `... (${rest}, or raise maxLines for the whole body)`,
      ].join('\n');
    })
    .join('\n\n');
}

server.registerTool(
  'get-symbol',
  {
    description:
      'Print the source of platform declarations: a function, const, schema, type, interface, class or one method with `Owner.method` (e.g. "WalletService.withdraw", "WithdrawInputSchema"). A body over maxLines comes back as a numbered outline (members, or statements and their if/throw/await lines). Pass every name you need in one call. Use it instead of grepping for the definition and reading the file around it.',
    inputSchema: {
      names: namesInput('["WalletService.withdraw", "WithdrawInputSchema"]'),
      file: z
        .string()
        .optional()
        .describe('Path substring to pick one definition, for every name, e.g. "wallet/service"'),
      maxLines: z
        .number()
        .int()
        .min(5)
        .max(400)
        .optional()
        .describe(
          'Longest body printed whole, per declaration (default 80); longer ones come back as an outline',
        ),
    },
  },
  async ({ names, file, maxLines = 80 }) => {
    const source = loadSource();
    if (typeof source === 'string') {
      return textReply(source);
    }
    const budget = SYMBOL_LOCATION_LIMIT * maxLines;
    let used = 0;
    const sections = [...new Set(names)].map((name) => {
      const section = symbolOf(source, name, file, maxLines);
      const size = section.split('\n').length;
      if (used > 0 && used + size > budget) {
        return `(${name}: skipped, it would take this reply over ${budget} lines - ask for it in another call)`;
      }
      used += size;
      return section;
    });
    return textReply(sections.join('\n\n'));
  },
);

server.registerTool(
  'get-config-schema',
  {
    description:
      'Return the igaming-config surface: the DI token, the source file that defines it, and each configurable field with its note. Use this to learn what a consumer can configure (branding, currencies, jurisdictions, enabled modules, limits, ...).',
    inputSchema: {},
  },
  withCatalog((c) => {
    const lines: string[] = ['=== Igaming config ==='];
    lines.push(`token:  ${c.config.token}`);
    lines.push(`source: ${c.config.source}`);
    lines.push('\n--- Fields ---');
    for (const f of c.config.fields) {
      lines.push(`- ${f.key}${f.note ? `: ${f.note}` : ''}`);
    }
    return lines.join('\n');
  }),
);

function buildConsumerPlaybook(
  kind: IntentKind,
  ctx: { modules: string[]; tokens: string[] },
): string {
  const moduleList = ctx.modules.length
    ? ctx.modules.map((m) => `- ${m}`).join('\n')
    : '- (none yet)';
  switch (kind) {
    case 'feature':
      return [
        '## Where it goes',
        'New behavior in a consumer repo -> an overlay plugin (`pnpm gen plugin`). It can add routes, subscribe to events, and rebind adapters without touching OSS core.',
        'If this is a new business domain that should be in the OSS platform itself, open an issue on the OSS repo instead.',
        '',
        '## Existing platform modules you can hook into',
        moduleList,
        '',
        '## Playbook',
        '1. Spawn the `expert` agent (Task tool) to turn this ask into requirements + acceptance criteria (player journey, jurisdiction rules, edge cases). Skip only for a trivial change.',
        '2. Spawn the `builder` agent to implement: `pnpm gen plugin`, then in `register(ctx)` add routes (`ctx.routers.add`) and subscribe to events (`ctx.events.on`).',
        '3. Register the plugin in `extensions.config.ts` at the repo root.',
        '4. Spawn the `tester` agent to write/run a Playwright E2E test for the acceptance criteria.',
        '5. Run `pnpm check:types && pnpm check:lint`.',
        '',
        '## Agents',
        '- `expert` - requirements + AC (advisory, no code)',
        '- `builder` - implements the overlay',
        '- `tester` - E2E test + bug triage (OSS-core vs overlay)',
      ].join('\n');
    case 'adapter':
      return [
        '## Where it goes',
        'Swap a vendor implementation by implementing the adapter interface and binding it to the DI token.',
        '',
        '## Available adapter tokens',
        ctx.tokens.length
          ? ctx.tokens.map((t) => `- ${t}`).join('\n')
          : '- (run list-adapters for details)',
        '',
        '## Playbook',
        '1. If the adapter is compliance-sensitive (KYC/AML, PSP, geo), spawn the `expert` agent first to confirm jurisdiction requirements.',
        '2. Spawn the `builder` agent to implement: `pnpm gen adapter` (prompts for name + token), implement the interface, bind it in the generated plugin.',
        '3. Ensure the plugin is listed AFTER the module that owns the default binding in `extensions.config.ts` (last registration wins).',
        '4. Run `pnpm check:types && pnpm check:lint`.',
        '',
        '## Agents',
        '- `expert` - jurisdiction/compliance requirements (advisory)',
        '- `builder` - implements + binds the adapter',
      ].join('\n');
    case 'ui-page':
      return [
        '## Where it goes',
        'The platform is headless - pages live in your own frontend repo and consume the api via `@openora/core/react`.',
        '',
        '## Playbook',
        '1. Spawn the `builder` agent to implement the page in your frontend repo.',
        '2. Spawn the `tester` agent to verify the page renders and behaves in a browser.',
        '3. Run `pnpm check:types`.',
        '',
        '## Agents',
        '- `builder` - mounts/extends the page',
        '- `tester` - browser verification',
      ].join('\n');
    case 'route':
      return [
        '## Where it goes',
        'Add a route inside an overlay plugin - create one with `pnpm gen plugin`, then add the oRPC procedure in `register(ctx)` via `ctx.routers.add`.',
        '',
        '## Existing modules with routes',
        moduleList,
        '',
        '## Playbook',
        '1. Spawn the `builder` agent to implement: `pnpm gen plugin` if no overlay exists, then add the oRPC route in `register(ctx)`. Admin routes must assert AdminGuard first.',
        '2. Run `pnpm check:types && pnpm check:lint`.',
        '',
        '## Agents',
        '- `builder` - implements the route',
      ].join('\n');
    default:
      return [
        '## Not sure yet',
        'Spawn the `expert` agent to frame the ask in domain terms, or ask one clarifying question to map it to: feature (overlay plugin), adapter (vendor swap), ui-page, or route. Then re-call `enhance-intent` with the chosen kind.',
        '',
        '## Platform surface',
        `Modules: ${ctx.modules.join(', ') || '(none)'}`,
        `Adapter tokens: ${ctx.tokens.join(', ') || '(none)'}`,
        '',
        '## Agents available in this repo',
        '- `expert` - domain/product requirements (advisory)',
        '- `builder` - fullstack implementation',
        '- `tester` - E2E testing',
      ].join('\n');
  }
}

function runShell(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 });
    return { ok: true, output };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
    return {
      ok: false,
      output: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '') + err.message,
    };
  }
}

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

server.registerTool(
  'enhance-intent',
  {
    description:
      'Turn a fuzzy "I want to build X" ask into a grounded, consumer-context brief. Uses the platform catalog (live module and adapter list) to return a classified intent, a requirements checklist to collect from the user, a step-by-step playbook using the consumer pnpm gen commands, and an acceptance-criteria stub.',
    inputSchema: {
      ask: z
        .string()
        .describe("The user's raw request, eg 'add a VIP loyalty tier with point tracking'"),
      kind: z
        .enum(['feature', 'adapter', 'ui-page', 'route', 'unsure'])
        .optional()
        .describe('Override auto-classification if you already know the kind.'),
    },
  },
  async ({ ask, kind }) => {
    const loaded = loadCatalog();
    const catalog = loaded?.catalog;
    const resolved = kind && kind !== 'unsure' ? kind : classifyIntent(ask);
    const ctx = {
      modules: catalog?.modules.map((m) => `${m.group}/${m.id}`) ?? [],
      tokens: catalog?.adapters.map((a) => a.token) ?? [],
    };
    const detected = kind && kind !== 'unsure' ? '' : ' (auto-detected)';
    const text = [
      '# Enhanced brief',
      '',
      '## Restated intent',
      `> ${ask.trim()}`,
      '',
      `## Classification: ${resolved}${detected}`,
      '',
      '## Requirements - collect these from the user FIRST (if not already gathered)',
      'A one-line ask is a starting point, not a spec. Your main job is to gather thorough requirements; the agents do the rest.',
      '',
      REQUIREMENTS_INTERVIEW,
      '',
      buildConsumerPlaybook(resolved, ctx),
      '',
      '## Acceptance criteria (derive from the requirements above)',
      '- [ ] Happy path works end to end',
      '- [ ] Edge cases handled',
      '- [ ] `pnpm check:types && pnpm check:lint` is green',
    ].join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.registerTool(
  'start',
  {
    description:
      'Onboarding entry point. Call when the user opens Claude Code in a fresh consumer repo, says "start", "help me build X", or asks what they can do. Returns a structured onboarding script to follow: questions to ask, options to present, what to do with answers.',
    inputSchema: {
      ask: z
        .string()
        .optional()
        .describe(
          "Pass the user's raw ask if already known. Omit to get the full interactive flow.",
        ),
    },
  },
  async ({ ask }) => {
    const loaded = loadCatalog();
    const catalog = loaded?.catalog;
    const modules = catalog?.modules.map((m) => `${m.group}/${m.id}`) ?? [];
    const tokens = catalog?.adapters.map((a) => a.token) ?? [];

    const role = [
      '## Your role',
      'You are a requirements interviewer and orchestrator, NOT the implementer. Your one human-facing job is to collect thorough requirements from the user. Everything after that - scaffolding, code, tests - you delegate to the agents (`expert`, `builder`, `tester`) via the Task tool. Keep the user out of the loop after requirements are confirmed, except to resolve genuine decisions only they can make.',
    ].join('\n');

    if (ask) {
      const resolved = classifyIntent(ask);
      const playbook = buildConsumerPlaybook(resolved, {
        modules,
        tokens,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: [
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
            ].join('\n'),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: [
            '# Onboarding - follow this script',
            '',
            role,
            '',
            '## Step 1: high-level intent (AskUserQuestion, single-select)',
            'Present AT MOST 4 options - AskUserQuestion rejects more, and it auto-adds an "Other" for anything else. This only routes the playbook, so keep it light:',
            'Question: "What do you want to build?"',
            '- New feature or behavior (bonus, campaign, player flow) -> kind: feature',
            '- Swap a vendor adapter (payment / KYC / notifications) -> kind: adapter',
            '- Add a UI page (player or backoffice) -> kind: ui-page',
            '- Explore / not sure -> kind: unsure',
            'A one-off API route or anything else: map the free-text answer to the closest kind (route -> feature, or unsure); enhance-intent will refine it.',
            '',
            '## Step 2: requirements interview (spend most of your effort here)',
            REQUIREMENTS_INTERVIEW,
            '',
            '## Step 3: delegate everything',
            'Call `enhance-intent` (ask = the confirmed requirements summary, kind = step 1). Then follow its playbook, which delegates to the agents:',
            '- `expert` formalizes requirements + acceptance criteria (and may surface gaps - if so, ask the user those, then continue).',
            '- `builder` implements (`pnpm gen ...`, code).',
            '- `tester` writes/runs the E2E test.',
            'You orchestrate; you do not write feature code yourself.',
            '',
            `Platform modules: ${modules.join(', ') || '(catalog not loaded)'}`,
          ].join('\n'),
        },
      ],
    };
  },
);

let builtGraph: DepGraph | null = null;

function localGraph(rebuild: boolean): DepGraph {
  const prebuilt = join(process.cwd(), 'dep-graph.json');
  if (!rebuild && existsSync(prebuilt)) {
    return JSON.parse(readFileSync(prebuilt, 'utf8')) as DepGraph;
  }
  if (rebuild || !builtGraph) {
    builtGraph = buildDepGraph(process.cwd());
  }
  return builtGraph;
}

function platformGraph(): DepGraph | null {
  const shipped = join(here, '..', 'docs', 'dep-graph.json');
  return existsSync(shipped) ? (JSON.parse(readFileSync(shipped, 'utf8')) as DepGraph) : null;
}

server.registerTool(
  'impact',
  {
    description:
      'Blast radius of a change: for each repo-relative file, the files that import it (transitively), and for a platform file (packages/core/src/...) the public @openora/* entry points it reaches plus the consumer files importing them. Use before editing a shared file, or to decide what to re-test after a change.',
    inputSchema: {
      files: z
        .array(z.string())
        .min(1)
        .describe('Repo-relative paths, e.g. "apps/web/src/lib/x.ts"'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Import hops to follow (default 4)'),
      rebuild: z
        .boolean()
        .optional()
        .describe('Re-cruise the repo instead of using a cached graph'),
    },
  },
  async ({ files, depth = 4, rebuild = false }) => {
    let local: DepGraph;
    try {
      local = localGraph(rebuild);
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Could not build the graph: ${String(error)}` }],
      };
    }
    const platform = platformGraph();
    const list = (items: string[], max = 40) =>
      items.length === 0
        ? '  (none)'
        : items
            .slice(0, max)
            .map((i) => `  - ${i}`)
            .join('\n') + (items.length > max ? `\n  (+${items.length - max} more)` : '');
    const sections = files.map((file) => {
      const known = (g: DepGraph) =>
        file in g.dependents || file in g.entryPoints || file in g.platform;
      const onPlatform = platform && !known(local) && known(platform);
      const impact = onPlatform
        ? impactOf(platform, file, depth, local)
        : impactOf(local, file, depth);
      const lines = [
        `=== ${file} ===`,
        `Importers (${impact.importers.length}):`,
        list(impact.importers),
      ];
      if (impact.specifiers.length > 0) {
        lines.push(`Public entry points reached:`, list(impact.specifiers));
      }
      if (onPlatform) {
        lines.push(`Files in this repo importing them:`, list(impact.consumerFiles));
      }
      const imports = local.platform[file];
      if (imports?.length) {
        lines.push(`Platform imports of this file:`, list(imports));
      }
      return lines.join('\n');
    });
    return { content: [{ type: 'text' as const, text: sections.join('\n\n') }] };
  },
);

server.registerTool(
  'dev:infra',
  {
    description:
      'Start / stop / status local dev infrastructure via docker compose (postgres on :5432). Call before pnpm db:migrate or pnpm dev when the database is not reachable.',
    inputSchema: {
      action: z
        .enum(['up', 'down', 'status'])
        .optional()
        .describe(
          'up (default): start containers. down: stop and remove. status: show running containers.',
        ),
    },
  },
  async ({ action = 'up' }) => {
    if (action === 'status') {
      const r = runShell('docker compose ps');
      return { content: [{ type: 'text' as const, text: r.output || '(no output)' }] };
    }
    if (action === 'down') {
      const r = runShell('docker compose down');
      return { content: [{ type: 'text' as const, text: r.ok ? 'Stopped.' : r.output }] };
    }
    const up = runShell('docker compose up -d');
    if (!up.ok) {
      return {
        content: [{ type: 'text' as const, text: `docker compose up failed:\n${up.output}` }],
      };
    }

    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (runShell('docker compose exec -T postgres pg_isready -U postgres').ok) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    const text = ready
      ? 'Postgres is ready on :5432.\n\nNext: pnpm db:migrate then pnpm dev.'
      : 'Containers started but postgres did not become ready within 30s.\nRun `docker compose logs postgres` to investigate.';
    return { content: [{ type: 'text' as const, text: text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

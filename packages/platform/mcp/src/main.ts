import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Catalog shape (docs/catalog.json - generated upstream by tools/gen-catalog.ts)
// ---------------------------------------------------------------------------

interface CatalogModule {
  id: string;
  group: string;
  tables: string[];
  routes: string[];
}

interface CatalogAdapter {
  category: string;
  interface: string;
  token: string;
  status: string;
  boundIn: string[];
}

interface CatalogUiSlot {
  name: string;
  description: string;
}

interface CatalogSchema {
  name: string;
  file: string;
}

interface CatalogConfigField {
  key: string;
  note: string;
}

interface CatalogConfig {
  token: string;
  source: string;
  fields: CatalogConfigField[];
}

interface Catalog {
  modules: CatalogModule[];
  adapters: CatalogAdapter[];
  events: string[];
  uiSlots: CatalogUiSlot[];
  schemas: CatalogSchema[];
  config: CatalogConfig;
  pluginContract: string[];
  httpRoutes: string[];
}

const NOT_FOUND_MESSAGE =
  'catalog.json not found - run `pnpm regen` in the platform repo, or set OSS_CATALOG to its path.';

// ---------------------------------------------------------------------------
// Catalog resolution + loading (runtime fs read - never `import` the JSON)
// ---------------------------------------------------------------------------

/** Candidate paths to probe, in priority order. */
function catalogCandidates(): string[] {
  const candidates: string[] = [];

  // 1. Explicit override.
  const override = process.env['OSS_CATALOG'];
  if (override) candidates.push(override);

  const cwd = process.cwd();

  // 2a. cwd-relative common locations.
  candidates.push(join(cwd, 'docs', 'catalog.json'));
  candidates.push(join(cwd, 'node_modules', '@oss', 'mcp', 'docs', 'catalog.json'));

  // 2b. Walk up from cwd looking for docs/catalog.json.
  let dir = cwd;
  for (;;) {
    candidates.push(join(dir, 'docs', 'catalog.json'));
    const parent = parse(dir).dir;
    if (!parent || parent === dir) break;
    dir = parent;
  }

  // 2c. The package's own bundled snapshot (relative to compiled main.js).
  candidates.push(join(here, '..', 'docs', 'catalog.json'));

  return candidates;
}

/** Locate and read the catalog. Returns null (never throws) if not found/invalid. */
function loadCatalog(): { catalog: Catalog; path: string } | null {
  for (const candidate of catalogCandidates()) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const catalog = JSON.parse(readFileSync(candidate, 'utf8')) as Catalog;
      return { catalog, path: candidate };
    } catch {
      // Corrupt file at this path - keep probing.
    }
  }
  return null;
}

/** Wrap a handler so it loads the catalog once and short-circuits with a helpful
 * message when the catalog is missing. */
function withCatalog(fn: (catalog: Catalog) => string) {
  return async () => {
    const loaded = loadCatalog();
    if (!loaded) {
      return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    }
    return { content: [{ type: 'text' as const, text: fn(loaded.catalog) }] };
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'oss',
  version: '0.1.0',
});

// --- catalog-overview -------------------------------------------------------
server.tool(
  'catalog-overview',
  'START HERE. A concise "what can I extend" summary of the OSS igaming platform you are consuming: counts of modules/events/slots/schemas, the adapter swap-seam table (category/interface/token/status), and the igaming-config fields. Read this first to orient before drilling into the other tools.',
  {},
  withCatalog((c) => {
    const lines: string[] = ['=== OSS igaming platform catalog ==='];
    lines.push(
      `modules: ${c.modules.length}  adapters: ${c.adapters.length}  events: ${c.events.length}  ` +
        `uiSlots: ${c.uiSlots.length}  schemas: ${c.schemas.length}  ` +
        `httpRoutes: ${c.httpRoutes.length}`,
    );

    lines.push('\n--- Adapter seams (implement an interface, bind to the token) ---');
    for (const a of c.adapters) {
      lines.push(`- ${a.category}: ${a.interface} -> ${a.token}  [${a.status}]`);
    }

    lines.push(`\n--- Config (${c.config.token}) ---`);
    for (const f of c.config.fields) {
      lines.push(`- ${f.key}${f.note ? `: ${f.note}` : ''}`);
    }

    lines.push(
      '\nNext: list-adapters | list-routes | list-events | list-slots | describe-module <name> | schema-get <name> | get-config-schema',
    );
    return lines.join('\n');
  }),
);

// --- list-adapters ----------------------------------------------------------
server.tool(
  'list-adapters',
  'List the vendor adapter swap-seams (PSP/KYC/game/aggregator/geo-ip/notification). For each: the interface to implement, the DI token to bind it to, whether it is already wired or a stub awaiting an implementation, and where it is bound. Use this to find the integration point for a third-party vendor.',
  {},
  withCatalog((c) => {
    if (c.adapters.length === 0) return 'No adapters in the catalog.';
    const lines: string[] = ['=== Adapter seams ==='];
    for (const a of c.adapters) {
      lines.push(`\n${a.category}  [${a.status}]`);
      lines.push(`  interface: ${a.interface}`);
      lines.push(`  token:     ${a.token}`);
      if (a.boundIn.length > 0) lines.push(`  boundIn:   ${a.boundIn.join(', ')}`);
      else lines.push('  boundIn:   (none - stub; bind your implementation to the token)');
    }
    return lines.join('\n');
  }),
);

// --- list-routes ------------------------------------------------------------
server.tool(
  'list-routes',
  'List oRPC route namespaces exposed by the platform modules. Pass `module` to scope to a single module. Includes top-level httpRoutes when present.',
  { module: z.string().optional().describe('Module id to filter by (e.g. "wallet")') },
  async ({ module: mod }) => {
    const loaded = loadCatalog();
    if (!loaded) return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
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
      if (m.routes.length > 0) {
        lines.push(`${m.id}:\n${m.routes.map((r) => `  ${r}`).join('\n')}`);
      }
    }
    if (!mod && c.httpRoutes.length > 0) {
      lines.push(`httpRoutes:\n${c.httpRoutes.map((r) => `  ${r}`).join('\n')}`);
    }
    const text = lines.join('\n\n') || 'No routes defined in the catalog yet.';
    return { content: [{ type: 'text' as const, text }] };
  },
);

// --- list-events ------------------------------------------------------------
server.tool(
  'list-events',
  'List the cross-module domain events you can subscribe to (via ctx.events.on in a plugin) or that signal platform activity. Use this to find the event to hook into for side effects.',
  {},
  withCatalog((c) => {
    if (c.events.length === 0) return 'No events in the catalog.';
    return `=== Domain events (${c.events.length}) ===\n${c.events.map((e) => `- ${e}`).join('\n')}`;
  }),
);

// --- list-slots -------------------------------------------------------------
server.tool(
  'list-slots',
  'List the named UI slots you can fill from a client-side UI plugin (ctx.<slot>.add(...)) to extend the backoffice without forking: nav items, table columns, dashboard tiles, detail sections. Includes each slot description and subject type.',
  {},
  withCatalog((c) => {
    if (c.uiSlots.length === 0) return 'No UI slots in the catalog.';
    const lines: string[] = ['=== UI slots ==='];
    for (const s of c.uiSlots) {
      lines.push(`- ${s.name}${s.description ? `  # ${s.description}` : ''}`);
    }
    return lines.join('\n');
  }),
);

// --- describe-module --------------------------------------------------------
server.tool(
  'describe-module',
  "Describe one platform module from the catalog: its group (player/backoffice/platform), Drizzle tables, and oRPC routes. Use this to understand a module's surface before extending or integrating with it.",
  { name: z.string().describe('Module id (e.g. "wallet", "gaming")') },
  async ({ name }) => {
    const loaded = loadCatalog();
    if (!loaded) return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
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
    lines.push(`\n--- Tables ---\n${m.tables.length > 0 ? m.tables.map((t) => `- ${t}`).join('\n') : '(none)'}`);
    lines.push(`\n--- Routes ---\n${m.routes.length > 0 ? m.routes.map((r) => `- ${r}`).join('\n') : '(none)'}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// --- schema-get -------------------------------------------------------------
server.tool(
  'schema-get',
  'Locate a Zod contract schema by name and return the file that defines it. The actual shape is read from the package types you have installed; this tells you WHERE the schema lives so you can import it.',
  { name: z.string().describe('Schema name, e.g. "WalletBalance" or "WalletBalanceSchema"') },
  async ({ name }) => {
    const loaded = loadCatalog();
    if (!loaded) return { content: [{ type: 'text' as const, text: NOT_FOUND_MESSAGE }] };
    const c = loaded.catalog;
    const candidates = name.endsWith('Schema') ? [name] : [`${name}Schema`, name];
    const hit = c.schemas.find((s) => candidates.includes(s.name));
    if (hit) {
      return { content: [{ type: 'text' as const, text: `${hit.name}\n${hit.file}` }] };
    }
    const list = c.schemas
      .map((s) => s.name)
      .sort()
      .join(', ');
    return {
      content: [
        { type: 'text' as const, text: `Schema "${name}" not found.\n\nAvailable schemas:\n${list}` },
      ],
    };
  },
);

// --- get-config-schema ------------------------------------------------------
server.tool(
  'get-config-schema',
  'Return the igaming-config surface: the DI token, the source file that defines it, and each configurable field with its note. Use this to learn what a consumer can configure (branding, currencies, jurisdictions, enabled modules, limits, ...).',
  {},
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

// ---------------------------------------------------------------------------
// Start (stdio transport)
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);

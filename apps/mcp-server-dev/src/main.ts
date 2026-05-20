import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  "Read a module's AGENTS.md, its schemas, and router surface.",
  { name: z.string().describe('Module name (kebab-case)') },
  async ({ name }) => {
    const base = repoPath('packages', 'modules', name);
    const overlayBase = repoPath('apps', 'extensions', name);
    const dir = existsSync(base) ? base : existsSync(overlayBase) ? overlayBase : null;

    if (!dir) {
      return { content: [{ type: 'text', text: `Module "${name}" not found.` }] };
    }

    const parts: string[] = [];
    parts.push(`=== Module: ${name} ===\n`);
    parts.push(readFile(join(dir, 'AGENTS.md')) || '(no AGENTS.md)');
    parts.push('\n--- Schemas ---');
    parts.push(readFile(join(dir, 'src', 'schemas', 'index.ts')) || '(empty)');
    parts.push('\n--- Router ---');
    parts.push(readFile(join(dir, 'src', 'router', 'index.ts')) || '(empty)');
    parts.push('\n--- Prisma partial ---');
    parts.push(readFile(join(dir, 'prisma.partial.prisma')) || '(empty)');

    return { content: [{ type: 'text', text: parts.join('\n') }] };
  },
);

// --- list-routes ------------------------------------------------------------
server.tool(
  'list-routes',
  'List all oRPC route namespaces across modules. Pass module name to filter.',
  { module: z.string().optional() },
  async ({ module: mod }) => {
    const modulesDir = repoPath('packages', 'modules');
    const dirs = mod ? [mod] : listDirs(modulesDir);
    const lines: string[] = [];
    for (const d of dirs) {
      const routerFile = join(modulesDir, d, 'src', 'router', 'index.ts');
      if (!existsSync(routerFile)) continue;
      const src = readFileSync(routerFile, 'utf8');
      const procedures = [...src.matchAll(/^\s{2,}(\w+):\s*os\b/gm)].map((m) => `  ${d}.${m[1]}`);
      if (procedures.length > 0) lines.push(`${d}:\n${procedures.join('\n')}`);
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

    // UI slots from provider-contract
    const contractIndex = repoPath('packages', 'ui', 'provider-contract', 'src', 'index.ts');
    if (existsSync(contractIndex)) {
      const src = readFileSync(contractIndex, 'utf8');
      const slots = [...src.matchAll(/['"]([a-z]+-[a-z-]+)['"]/g)].map((m) => m[1]);
      parts.push(
        `=== UI slots ===\n${[...new Set(slots)].map((s) => `- ${s}`).join('\n') || '(none defined yet)'}`,
      );
    }

    // Events from platform/events
    const eventsFile = repoPath('packages', 'platform', 'events', 'src', 'types.ts');
    if (existsSync(eventsFile)) {
      parts.push(`\n=== Events ===\n${readFile(eventsFile)}`);
    } else {
      parts.push('\n=== Events ===\n(types.ts not defined yet)');
    }

    // Ports from each module
    const moduleDirs = listDirs(repoPath('packages', 'modules'));
    parts.push('\n=== Ports (adapter interfaces) ===');
    for (const d of moduleDirs) {
      const portsFile = repoPath('packages', 'modules', d, 'src', 'service', 'ports.ts');
      if (existsSync(portsFile)) {
        const src = readFileSync(portsFile, 'utf8');
        const interfaces = [...src.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]);
        if (interfaces.length > 0) parts.push(`${d}: ${interfaces.join(', ')}`);
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
for (const [toolName, args] of [
  ['scaffold-module', 'module {{name}}'],
  ['scaffold-plugin', 'plugin {{name}}'],
] as const) {
  server.tool(
    toolName,
    `Run pnpm ${toolName} (delegates to tools/scaffold.ts)`,
    { name: z.string() },
    async ({ name }) => {
      const cmd = `pnpm scaffold ${args.replace('{{name}}', name)}`;
      const result = run(cmd);
      return {
        content: [{ type: 'text', text: result.output || (result.ok ? 'Done.' : 'Failed.') }],
      };
    },
  );
}

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
  'Run pnpm regen: merges Prisma partials, generates client, emits OpenAPI spec.',
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

// --- get-prisma-model-graph -------------------------------------------------
server.tool(
  'get-prisma-model-graph',
  'Return the merged Prisma schema with model definitions and relations.',
  {},
  async () => {
    const schemaPath = repoPath('infra', 'prisma', 'schema.prisma');
    const content = readFile(schemaPath);
    return {
      content: [
        { type: 'text', text: content || 'schema.prisma not found. Run `pnpm regen` first.' },
      ],
    };
  },
);

// --- propose-prisma-change --------------------------------------------------
server.tool(
  'propose-prisma-change',
  'Validate a proposed model name against the merged schema. Checks for table name collisions.',
  { model: z.string().describe('PascalCase model name to check') },
  async ({ model }) => {
    const schemaPath = repoPath('infra', 'prisma', 'schema.prisma');
    const content = readFile(schemaPath);
    const regex = new RegExp(`^model\\s+${model}\\s+\\{`, 'm');
    if (regex.test(content)) {
      return {
        content: [
          {
            type: 'text',
            text: `[COLLISION] Model "${model}" already exists in the merged schema.`,
          },
        ],
      };
    }

    // Also check partial files
    const moduleDirs = listDirs(repoPath('packages', 'modules'));
    for (const d of moduleDirs) {
      const partial = repoPath('packages', 'modules', d, 'prisma.partial.prisma');
      if (existsSync(partial) && regex.test(readFileSync(partial, 'utf8'))) {
        return {
          content: [
            {
              type: 'text',
              text: `[COLLISION] Model "${model}" already defined in packages/modules/${d}/prisma.partial.prisma.`,
            },
          ],
        };
      }
    }

    return { content: [{ type: 'text', text: `[OK] Model name "${model}" is available.` }] };
  },
);

// ---------------------------------------------------------------------------
// Start (stdio transport for Claude Code)
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);

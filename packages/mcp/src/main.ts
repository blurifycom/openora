import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

type CatalogModule = {
  id: string;
  group: string;
  tables: string[];
  routes: string[];
};

type CatalogAdapter = {
  category: string;
  interface: string;
  token: string;
  status: string;
  boundIn: string[];
};

type CatalogUiSlot = {
  name: string;
  description: string;
};

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

type Catalog = {
  modules: CatalogModule[];
  adapters: CatalogAdapter[];
  events: string[];
  uiSlots: CatalogUiSlot[];
  schemas: CatalogSchema[];
  config: CatalogConfig;
  pluginContract: string[];
  httpRoutes: string[];
};

const NOT_FOUND_MESSAGE =
  'catalog.json not found - run `pnpm regen` in the platform repo, or set OSS_CATALOG to its path.';

function catalogCandidates(): string[] {
  const candidates: string[] = [];

  const override = process.env['OSS_CATALOG'];
  if (override) candidates.push(override);

  const cwd = process.cwd();

  candidates.push(join(cwd, 'docs', 'catalog.json'));
  candidates.push(join(cwd, 'node_modules', '@oss', 'mcp', 'docs', 'catalog.json'));

  let dir = cwd;
  for (;;) {
    candidates.push(join(dir, 'docs', 'catalog.json'));
    const parent = parse(dir).dir;
    if (!parent || parent === dir) break;
    dir = parent;
  }

  candidates.push(join(here, '..', 'docs', 'catalog.json'));

  return candidates;
}

function loadCatalog(): { catalog: Catalog; path: string } | null {
  for (const candidate of catalogCandidates()) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const catalog = JSON.parse(readFileSync(candidate, 'utf8')) as Catalog;
      return { catalog, path: candidate };
    } catch {
      // corrupt file - keep probing
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
  version: '0.1.0',
});

server.registerTool(
  'catalog-overview',
  {
    description:
      'START HERE. A concise "what can I extend" summary of the OSS igaming platform you are consuming: counts of modules/events/slots/schemas, the adapter swap-seam table (category/interface/token/status), and the igaming-config fields. Read this first to orient before drilling into the other tools.',
    inputSchema: {},
  },
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

server.registerTool(
  'list-adapters',
  {
    description:
      'List the vendor adapter swap-seams (PSP/KYC/game/aggregator/geo-ip/notification). For each: the interface to implement, the DI token to bind it to, whether it is already wired or a stub awaiting an implementation, and where it is bound. Use this to find the integration point for a third-party vendor.',
    inputSchema: {},
  },
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

server.registerTool(
  'list-routes',
  {
    description:
      'List oRPC route namespaces exposed by the platform modules. Pass `module` to scope to a single module. Includes top-level httpRoutes when present.',
    inputSchema: {
      module: z.string().optional().describe('Module id to filter by (e.g. "wallet")'),
    },
  },
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

server.registerTool(
  'list-events',
  {
    description:
      'List the cross-module domain events you can subscribe to (via ctx.events.on in a plugin) or that signal platform activity. Use this to find the event to hook into for side effects.',
    inputSchema: {},
  },
  withCatalog((c) => {
    if (c.events.length === 0) return 'No events in the catalog.';
    return `=== Domain events (${c.events.length}) ===\n${c.events.map((e) => `- ${e}`).join('\n')}`;
  }),
);

server.registerTool(
  'list-slots',
  {
    description:
      'List the named UI slots you can fill from a client-side UI plugin (ctx.<slot>.add(...)) to extend the backoffice without forking: nav items, table columns, dashboard tiles, detail sections. Includes each slot description and subject type.',
    inputSchema: {},
  },
  withCatalog((c) => {
    if (c.uiSlots.length === 0) return 'No UI slots in the catalog.';
    const lines: string[] = ['=== UI slots ==='];
    for (const s of c.uiSlots) {
      lines.push(`- ${s.name}${s.description ? `  # ${s.description}` : ''}`);
    }
    return lines.join('\n');
  }),
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
    lines.push(
      `\n--- Tables ---\n${m.tables.length > 0 ? m.tables.map((t) => `- ${t}`).join('\n') : '(none)'}`,
    );
    lines.push(
      `\n--- Routes ---\n${m.routes.length > 0 ? m.routes.map((r) => `- ${r}`).join('\n') : '(none)'}`,
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.registerTool(
  'schema-get',
  {
    description:
      'Locate a Zod contract schema by name and return the file that defines it. The actual shape is read from the package types you have installed; this tells you WHERE the schema lives so you can import it.',
    inputSchema: {
      name: z.string().describe('Schema name, e.g. "WalletBalance" or "WalletBalanceSchema"'),
    },
  },
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
        {
          type: 'text' as const,
          text: `Schema "${name}" not found.\n\nAvailable schemas:\n${list}`,
        },
      ],
    };
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

type IntentKind = 'feature' | 'adapter' | 'ui-page' | 'route' | 'unsure';

function classifyIntent(ask: string): IntentKind {
  const a = ` ${ask.toLowerCase()} `;
  const has = (re: RegExp) => re.test(a);
  if (
    has(/\b(payment|psp|stripe|adyen|kyc|onfido|sms|email|notification|vendor|adapter|gateway)\b/)
  )
    return 'adapter';
  if (has(/\b(page|screen|dashboard|view|frontend|admin panel|backoffice page|player page)\b/))
    return 'ui-page';
  if (has(/\b(endpoint|route|procedure|api method|rpc)\b/)) return 'route';
  if (
    has(/\b(feature|module|tournament|leaderboard|jackpot|loyalty|bonus|cashback|mission|reward)\b/)
  )
    return 'feature';
  return 'unsure';
}

function buildConsumerPlaybook(
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
        'New behavior in a consumer repo -> an overlay plugin (`pnpm gen plugin`). It can add routes, subscribe to events, rebind adapters, and fill UI slots without touching OSS core.',
        'If this is a new business domain that should be in the OSS platform itself, open an issue on the OSS repo instead.',
        '',
        '## Existing platform modules you can hook into',
        moduleList,
        '',
        '## Playbook',
        '1. Spawn the `igaming-expert` agent (Task tool) to turn this ask into requirements + acceptance criteria (player journey, jurisdiction rules, edge cases). Skip only for a trivial change.',
        '2. Spawn the `igaming-builder` agent to implement: `pnpm gen plugin`, then in `register(ctx)` add routes (`ctx.routers.add`), subscribe to events (`ctx.events.on`), fill slots (`ctx.slots.fill`).',
        '3. Register the plugin in `apps/api/src/extensions.config.ts`.',
        '4. Spawn the `igaming-qa` agent to write/run a Playwright E2E test for the acceptance criteria.',
        '5. Run `pnpm typecheck && pnpm lint`.',
        '',
        '## Agents',
        '- `igaming-expert` - requirements + AC (advisory, no code)',
        '- `igaming-builder` - implements the overlay',
        '- `igaming-qa` - E2E test + bug triage (OSS-core vs overlay)',
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
        '1. If the adapter is compliance-sensitive (KYC/AML, PSP, geo), spawn the `igaming-expert` agent first to confirm jurisdiction requirements.',
        '2. Spawn the `igaming-builder` agent to implement: `pnpm gen adapter` (prompts for name + token), implement the interface, bind it in the generated plugin.',
        '3. Ensure the plugin is listed AFTER the module that owns the default binding in `extensions.config.ts` (last registration wins).',
        '4. Run `pnpm typecheck && pnpm lint`.',
        '',
        '## Agents',
        '- `igaming-expert` - jurisdiction/compliance requirements (advisory)',
        '- `igaming-builder` - implements + binds the adapter',
      ].join('\n');
    case 'ui-page':
      return [
        '## Where it goes',
        'The platform is headless - pages live in your own frontend repo and consume the api via `@oss/core/react`. Fill named UI slots from a client-side UI plugin.',
        '',
        '## Named UI slots you can fill (via defineUIPlugin)',
        ctx.slots.length
          ? ctx.slots.map((s) => `- ${s}`).join('\n')
          : '- (run list-slots for details)',
        '',
        '## Playbook',
        '1. Spawn the `igaming-builder` agent to implement the page in your frontend repo, or extend an existing surface via `defineUIPlugin` into a slot above.',
        '2. Spawn the `igaming-qa` agent to verify the page renders and behaves in a browser.',
        '3. Run `pnpm typecheck`.',
        '',
        '## Agents',
        '- `igaming-builder` - mounts/extends the page',
        '- `igaming-qa` - browser verification',
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
        '1. Spawn the `igaming-builder` agent to implement: `pnpm gen plugin` if no overlay exists, then add the oRPC route in `register(ctx)`. Admin routes must assert AdminGuard first.',
        '2. Run `pnpm typecheck && pnpm lint`.',
        '',
        '## Agents',
        '- `igaming-builder` - implements the route',
      ].join('\n');
    default:
      return [
        '## Not sure yet',
        'Spawn the `igaming-expert` agent to frame the ask in domain terms, or ask one clarifying question to map it to: feature (overlay plugin), adapter (vendor swap), ui-page, or route. Then re-call `enhance-intent` with the chosen kind.',
        '',
        '## Platform surface',
        `Modules: ${ctx.modules.join(', ') || '(none)'}`,
        `Adapter tokens: ${ctx.tokens.join(', ') || '(none)'}`,
        '',
        '## Agents available in this repo',
        '- `igaming-expert` - domain/product requirements (advisory)',
        '- `igaming-builder` - fullstack implementation',
        '- `igaming-qa` - E2E testing',
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
      'Turn a fuzzy "I want to build X" ask into a grounded, consumer-context brief. Uses the platform catalog (live module/adapter/slot list) to return a classified intent, a requirements checklist to collect from the user, a step-by-step playbook using the consumer pnpm gen commands, and an acceptance-criteria stub.',
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
      slots: catalog?.uiSlots.map((s) => s.name) ?? [],
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
      '- [ ] `pnpm typecheck && pnpm lint` is green',
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
      'You are a requirements interviewer and orchestrator, NOT the implementer. Your one human-facing job is to collect thorough requirements from the user. Everything after that - scaffolding, code, tests - you delegate to the agents (`igaming-expert`, `igaming-builder`, `igaming-qa`) via the Task tool. Keep the user out of the loop after requirements are confirmed, except to resolve genuine decisions only they can make.',
    ].join('\n');

    if (ask) {
      const resolved = classifyIntent(ask);
      const playbook = buildConsumerPlaybook(resolved, {
        modules,
        tokens,
        slots: catalog?.uiSlots.map((s) => s.name) ?? [],
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
            '- `igaming-expert` formalizes requirements + acceptance criteria (and may surface gaps - if so, ask the user those, then continue).',
            '- `igaming-builder` implements (`pnpm gen ...`, code).',
            '- `igaming-qa` writes/runs the E2E test.',
            'You orchestrate; you do not write feature code yourself.',
            '',
            `Platform modules: ${modules.join(', ') || '(catalog not loaded - run pnpm build:oss first)'}`,
          ].join('\n'),
        },
      ],
    };
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
    if (!up.ok)
      return {
        content: [{ type: 'text' as const, text: `docker compose up failed:\n${up.output}` }],
      };

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

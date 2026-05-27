<!-- GitHub Copilot instructions -->
<!-- Auto-generated from AGENTS.md by `pnpm sync:agent-docs`. Edit AGENTS.md, not this file. -->

# AGENTS.md

Canonical brief for AI agents (Claude Code, Codex, Cursor, etc.) working on this repo. Humans read this too. `CLAUDE.md` is generated from this file - edit `AGENTS.md`, then run `pnpm sync:agent-docs`.

## Mission

Open-source, headless, plugin-based, AI-native igaming platform. Anyone clones the repo and extends it with their own modules, UI provider, and adapters. The default surface is fully playable (auth, wallet, lobby, chat, bonus, compliance, backoffice, CMS, aggregator). Consumer is the first downstream consumer; nothing Consumer-specific lives in this repo.

## Architecture pillars

1. Zod-first contracts. Every shape is a Zod schema; types are `z.infer`'d, never hand-written. Cross-cutting schemas live in `packages/contracts/shared-schemas`; per-module request/response schemas live in `packages/contracts/orpc-contract`, and module-local ones in the module's `schemas/`.
2. oRPC + Hono. oRPC owns route definition + Zod validation + OpenAPI emit; its `OpenAPIHandler` is mounted on a Hono server (`@hono/node-server`, Bun-ready later). Dependency wiring is a small functional composition container (`Container` in `@oss/core`) - explicit factory functions keyed by typed tokens, no decorators, no `reflect-metadata`. See ADR-0009.
3. Plugin host. `definePlugin({ id, dependsOn, register })` is the only way new functionality enters the system. Overlays (in-tree under `apps/extensions/<name>/`) are the primary path; npm-published plugins use the same contract.
4. Headless UI. `@oss/ui-provider-contract` declares component contracts and named slots. `@oss/ui-provider-shadcn` is the default adapter. Module UI never imports a UI library directly.
5. Explicit > magic. No auto-discovery, no decorator soup. Everything is greppable; every wiring point is a typed function call.
6. AI-friendly by default. Every module has an `AGENTS.md`. Every scaffold is a slash command. Every contract is queryable via the MCP dev server and the generated `docs/CATALOG.md`.

## Repo map

```
apps/
  api/            # Hono + oRPC HTTP API (port 3001) - thin consumer of createApp
  backoffice/     # Next.js admin app (reference consumer of the admin surface)
  web/            # Next.js player app (reference consumer of the player surface)
  mcp-server-dev/ # MCP dev server (stdio) - agents connect via .mcp.json
  storybook/      # Component playground (port 6006)
  extensions/     # In-tree overlay plugins (drop-in folders)
packages/
  config/         # tsconfig, vitest, oxlint, eslint-boundaries presets
  contracts/
    shared-schemas/ # Zod schemas - the source of truth
    orpc-contract/  # Root oRPC contract composing module routers
    adapters/       # @oss/adapters - vendor adapter interfaces + DI tokens (the swap seams)
  platform/
    core/         # logger, event bus (EventBus + EVENT_BUS), composition Container, tenant context
    auth/         # better-auth integration + shared AdminGuard
    db/           # @oss/db - Drizzle client (DrizzleService) + drizzle-kit migrations
    plugin-host/  # definePlugin, ModuleRegistry, loader
    mcp/          # @oss/mcp - publishable MCP server consumers run against their own repo
  modules/        # @oss/modules - ONE package; feature modules grouped by surface:
    player/       #   wallet gaming lobby chat bonus aggregator
    backoffice/   #   admin-console player-management cms
    platform/     #   identity notifications compliance localization
  sdks/
    sdk-core/     # @oss/sdk-core - framework-agnostic typed client
    react-sdk/    # @oss/react-sdk - React hooks + context + admin shell + pages
  ui/
    provider-contract/ # UIProvider type shape (Button, Input, DataTable, ...)
    provider-shadcn/   # default adapter (headless HTML + data-attrs)
    provider-daisyui/  # DaisyUI adapter (semantic Tailwind classes) - used by Consumer's player web
docs/
  adr/            # Architecture decision records
  architecture.md, glossary.md, agent-quickstart.md, downstream-consumer.md
  CATALOG.md      # generated machine-readable surface (routes/schemas/adapters/slots/events)
tools/            # scaffold.ts, sync-agent-docs.ts, gen-catalog.ts, verify-module-shape.ts
extensions.config.ts # the single registry of enabled plugins
```

## Where does X go? (decision tree)

- A new business domain (eg "tournaments") -> new module under `packages/modules/<group>/<name>/` (group: `player`, `backoffice`, `platform`). Use `/scaffold-module <group> <name>`.
- A behavior that extends/overrides an existing module -> overlay plugin under `apps/extensions/<name>/`. Use `/scaffold-plugin <name>`.
- A new HTTP route -> add to the module's `router/index.ts`. Use `/scaffold-route <module> <method> <path>`. Player routes resolve the caller from the `x-user-id` header; admin routes MUST be guarded (next line).
- An admin-only route -> the module's `plugin.ts` resolves `AdminGuard` from the container (`c.get(ADMIN_GUARD)`) and passes it into the router factory; call `await adminGuard.assert(context)` as the first line of the handler (throws `ORPCError`). `ADMIN_GUARD` is seeded into the container by `createApp`. This is the single admin-enforcement point - never re-implement the role check.
- A new database table -> add a Drizzle `pgTable` to the module's `src/schema/index.ts`. Run `pnpm regen` (drizzle-kit) to generate the migration.
- A reusable Zod schema -> `packages/contracts/shared-schemas/src/<namespace>.ts`. Module-local schemas live in the module's `schemas/`.
- A cross-module event -> declare the event type in `@oss/core` (`event-bus.ts`), emit via the `EventBus` the service received in its constructor (built in `plugin.ts` from `c.get(EVENT_BUS)`). See ADR-0010 for the event-driven direction and broker seam.
- A UI component -> `/scaffold-ui-component <name>` creates both the contract entry and the shadcn impl.
- A backoffice (admin) page -> add a component to `packages/sdks/react-sdk/src/pages/admin/`, export from `src/index.ts`, then add a Next route shim in `apps/backoffice/app/(authed)/<route>/page.tsx`. A player page goes in `src/pages/player/` with a shim in `apps/web/app/<route>/page.tsx`. See `packages/sdks/react-sdk/AGENTS.md`.
- A design token -> a `--bo-*` CSS variable in `react-sdk/src/styles.css` + a typed entry in `Theme` (`react-sdk/src/theme.tsx`). Override per-tenant via `<ThemeProvider theme={...}>`.
- A plugin-contributed admin UI extension (nav item, column, tile, section, route) -> a client-side `defineUIPlugin({ register(ctx) { ctx.<slot>.add(...) } })`. See ADR-0006 and `react-sdk/AGENTS.md`.
- A third-party integration (PSP, KYC, aggregator, chat) -> define the adapter interface + token (`createToken<Adapter>(...)`) in `@oss/adapters` (`packages/contracts/adapters/src/<category>.ts`), implement it under `packages/modules/<module>/adapters/<vendor>/`, and bind it in the module's `plugin.ts` via `ctx.provide(TOKEN, () => new Impl())`. Never inline. All vendor adapter interfaces live in `@oss/adapters` so the swap seams are findable in one place.
- A long-running task -> emit an event; handle it in a BullMQ worker overlay plugin (scaffold with `/scaffold-plugin <name>-worker`, add a BullMQ processor, bind it in the plugin's `register(ctx)`).

## Naming

- Packages: `@oss/<kebab>`. Feature modules are NOT separate packages - they live inside `@oss/modules` and are imported by subpath: `@oss/modules/<group>/<name>` and `@oss/modules/<group>/<name>/schema`.
- Files: `kebab-case.ts`. One concept per file.
- Types: `PascalCase`. Schemas: `<Name>Schema`. Inferred: `type <Name> = z.infer<typeof <Name>Schema>`.
- oRPC routers: namespace by module (`wallet.transactions.list`).
- Drizzle tables: snake_case `pgTable('table_name', ...)`; exported const is camelCase; row type is `typeof <const>.$inferSelect`.
- Tenant column: `tenantId` on every multi-tenant table.

## Dependency rules (enforced by boundary lint in `pnpm verify`)

- `packages/modules/**` may import: `@oss/contracts/*`, `@oss/adapters`, `@oss/platform/*`, `@oss/ui/*`, `@oss/sdks/*`. May NOT import another module - cross-module communication goes through events or contracts (read another module's tables via the `@oss/modules/<group>/<name>/schema` subpath).
- `packages/platform/*` may import other `platform/*` and `@oss/contracts/*`. May NOT import modules or UI.
- `packages/contracts/*` may only import other contracts and Zod.
- `apps/extensions/*` may import any package, but never another extension.
- `apps/api` registers modules only via `extensions.config.ts`. A direct module-file import from `apps/api/src/*` is a lint error.
- Consumers (and modules) import the package entry, never a deep `dist/` path.

## Forbidden patterns

- `any` outside `*.test.ts`. Use `unknown` + narrowing.
- Inline `fetch`/`axios`. Use the SDK or a vendor adapter.
- Ad-hoc Zod schemas inside routers/services. All schemas live in `schemas/` or `shared-schemas`.
- Decorators, anywhere. There is no decorator/DI framework - wire dependencies with explicit factory functions through the composition container.
- Re-exporting types just to "be nice". Import from where it's defined.
- TODOs without a tracking issue.
- A per-module `package.json`/`tsconfig.json` - all feature modules share `@oss/modules`. New deps go in `packages/modules/package.json`.
- Hand-editing generated drizzle migrations under `packages/platform/db/` - regenerate via `pnpm regen`.
- Hand-editing `docs/openapi.json` or `docs/CATALOG.md` - both are emitted at build time.

## How to add a module

```
/scaffold-module <group> <name>   (group: player | backoffice | platform)
```

Generates `packages/modules/<group>/<name>/` (a folder inside `@oss/modules`) with `src/schema/index.ts` (Drizzle tables), `src/schemas/index.ts` (Zod), `src/service/<name>.service.ts`, `src/router/index.ts`, `src/plugin.ts` (`definePlugin`), and `AGENTS.md`. The scaffolder registers the plugin in `extensions.config.ts` and wires the contract index. Run `pnpm regen && pnpm verify`. Each scaffolded file marks the regions you may edit with `// AGENT: implement here` - fill those; leave the wiring alone.

## How to add an extension (overlay plugin)

```
/scaffold-plugin <name>
```

Generates `apps/extensions/<name>/plugin.ts` exporting `definePlugin`. In `register(ctx)`: `ctx.provide(token, factory)`, `ctx.routers.add(namespace, (c) => router)`, `ctx.slots.fill(...)`, `ctx.events.on(...)`, `ctx.mcp.tool(...)`. To add tables, put your own `pgTable` in the overlay's schema (additive). To override a vendor adapter, `ctx.provide` your impl to its token AND ensure the overlay loads after the default-binding module in `extensions.config.ts` (last registration wins). See `apps/extensions/AGENTS.md`.

## How to add an oRPC route

```
/scaffold-route <module> <method> <path>
```

Adds a route stub with input/output schemas to the module's `router/index.ts`. Don't define ad-hoc schemas - import from `schemas/` or add to `shared-schemas`.

## How to extend the database schema (Drizzle)

Add/edit a `pgTable` in `packages/modules/<group>/<module>/src/schema/index.ts`. Check collisions with `propose-table-change` first. Run `pnpm regen` to produce the migration. Read another module's tables via the subpath import `@oss/modules/<group>/<module>/schema`.

## How to add a UI component contract

```
/scaffold-ui-component <Name>
```

Creates the contract entry (`packages/ui/provider-contract/src/components/<name>.ts`), the shadcn impl, and a Storybook story. Module UI may import only the contract type.

## How to consume this platform from a downstream repo

Scaffold a full consumer turborepo (api + web + backoffice) wired to `link:` at this checkout:

```
pnpm create:app ../my-igaming --name my-igaming
```

The generated repo ships `turbo gen` generators (`pnpm gen plugin|adapter|page`) and the three consumer AI agents. CLI: `tools/create-igaming-app.ts`; template: `tools/templates/consumer/`. See [docs/downstream-consumer.md](./docs/downstream-consumer.md) for `createApp`, mounting the backoffice, the `link:` dev workflow, the consumer load pattern, and the `@oss/mcp` + `CATALOG.md` AI surface. The smallest hand-wired reference is [`examples/minimal-igaming/`](./examples/minimal-igaming/).

## How to run things locally

```
pnpm setup:agent   # first time: docker + db + mcp + summary
pnpm dev           # turbo dev (api, backoffice, mcp, storybook)
pnpm regen         # drizzle-kit generate + openapi emit + sdk regen + catalog
pnpm seed          # demo data: admin + players + wallets + txns + games
pnpm verify        # typecheck + lint (incl. boundaries + module shape) + test
```

`pnpm seed` is idempotent and deterministic. Logs in with `admin@oss.dev` / `password123`. Flags: `--players=<n>`, `--admin-email=<e>`, `--admin-password=<p>`. The reusable `seedDemoData()` lives in `@oss/api-runtime` so downstream consumers can seed too.

## How to verify before opening a PR

```
pnpm verify
```

Must pass for every PR. CI runs the same plus a "no drift" check that re-runs drizzle-kit + the catalog generator and fails on an uncommitted diff.

## Agent roster

These agents are for **platform development** (building this OSS repo). Consumer igaming agents ship separately in `packages/platform/mcp/agents/`.

| Agent | Role | When to use |
|---|---|---|
| `igaming-expert` | Domain/product expert | Turn a fuzzy ask into requirements + AC; answer regulatory/rules questions |
| `igaming-fullstack-dev` | Senior fullstack engineer | Implement a module, plugin, adapter, or UI from a given spec |
| `oss-module-author` | Module scaffolder | Author a complete module end-to-end from the roadmap |
| `plugin-author` | Extension author | Create an overlay plugin that extends without touching core |
| `ui-provider-author` | UI adapter author | Implement `@oss/ui-provider-contract` for a target library |
| `igaming-operator-verifier` | Consumer readiness auditor | Audit platform from an operator perspective; find launch blockers |
| `contract-reviewer` | PR / boundary reviewer | Review a diff for breaking changes, boundary violations, schema drift |
| `qa-engineer` | E2E QA | Write/run Playwright tests; debug with Chrome DevTools; triage bugs |

## Conventions for agents specifically

- Read this file first, then the module's `AGENTS.md`, then ADRs. Don't reopen settled questions.
- The `oss-dev` MCP server is in `.mcp.json` (stdio, launched by your editor - no port), pre-approved via `enabledMcpjsonServers`. Verify with `claude mcp list` or `/mcp`.
- Use the MCP dev server for read-only inspection: `read-agents-md`, `list-modules`, `describe-module`, `list-routes`, `list-extension-points`, `query-openapi`, `get-drizzle-schema`, `propose-table-change`, `schema-get`, `docs-search`, `db-query-readonly`. It's faster than grep and reflects current state. Write ops (`scaffold-*`, `regen`, `run-verify`) delegate to the same scripts humans use.
- Before adding a route, call `query-openapi` to check it doesn't already exist. Before adding a table, call `propose-table-change`.
- After any change, run `pnpm verify` for the affected package. Fix failures before continuing.
- Prefer small PRs scoped to one module. Cross-module changes need explicit human approval.
- Don't commit unless asked. Don't push without confirmation.
- ASCII only in code. Short dashes (-) only, never long dashes.

# Agent Quickstart

This guide walks an AI agent through implementing a module end-to-end using only slash commands and the MCP dev server. Human involvement: review + approve the PR.

## Assumptions

- `pnpm setup:agent` has been run (Docker up, DB migrated, dependencies installed).
- The `oss-dev` MCP server is registered in `.mcp.json` and your agent launches it automatically (stdio). No separate process to start. Verify: `claude mcp list` (Claude Code), or check MCP settings in Cursor/Windsurf. See `docs/mcp-setup.md` for per-editor setup.

## Step 1: Understand the platform

```
read-agents-md section="Mission"
read-agents-md section="Architecture pillars"
read-agents-md section="Where does X go?"
```

Read the output before proceeding. Do not skip this.

## Step 2: Check if the module already exists

```
list-modules
```

If the module is listed, use `describe-module <name>` to understand its current state.

## Step 3: Scaffold the module

```
/scaffold-module <group> <name>   # group: player | backoffice | platform
```

This creates `packages/modules/<group>/<name>/` (a folder inside the single `@oss/modules` package - NOT its own package) with all required files and registers it in `extensions.config.ts`.

## Step 4: Define the Drizzle tables

Edit `packages/modules/<group>/<name>/src/schema/index.ts`. Add `pgTable` definitions following these rules:

- Every multi-tenant table has a `tenantId: text('tenantId').notNull()` column.
- No FK references to tables owned by other modules (use plain ID columns). Within your own module, `.references(() => table.id)` is fine.
- Table names are snake_case (`pgTable('tournament_entry', ...)`); the exported const is camelCase; the row type is `typeof <const>.$inferSelect`.

Check for table-name collisions before adding:

```
propose-table-change table=<snake_case_name>
```

Inspect the existing DB shape any time with `get-drizzle-schema` (pass `module=<name>` to scope). Then generate the migration:

```
/regen
```

## Step 5: Define schemas

Edit `packages/modules/<group>/<name>/src/schemas/index.ts`. Define Zod schemas for the module's entities. Check if a shared schema already exists:

```
schema-get name=<EntityName>
query-openapi keyword="<entity>"
```

If a shared schema exists in `@oss/contracts/shared-schemas`, re-export it instead of duplicating.

## Step 6: Implement the service

Edit `packages/modules/<group>/<name>/src/service/<name>.service.ts`. Business logic only. Rules:

- Take `DrizzleService` (from `@oss/db`) + `EventBus` as constructor arguments (the module plugin builds the service from the container). Query with `this.drizzle.db.select().from(<table>).where(eq(...))`; import operators (`eq`, `desc`, `sql`) from `drizzle-orm` and tables from `../schema/index.js`.
- Throw domain errors via `createDomainError(...)` from `@oss/core`.
- Never call external HTTP APIs directly - use an adapter interface from `@oss/adapters`.

## Step 7: Add routes

For each operation, add a route:

```
/scaffold-route <name> GET /<name>s
/scaffold-route <name> POST /<name>s
/scaffold-route <name> GET /<name>s/:id
```

Check existing routes first to avoid duplicates:

```
list-routes module=<name>
```

## Step 8: Wire the plugin

Edit `packages/modules/<group>/<name>/src/plugin.ts`. Confirm the service is added to `ctx.providers` and the router is added to `ctx.routers`. The registry surface is: `providers`, `controllers`, `routers`, `slots`, `events`, `mcp`, `imports`.

## Step 9: Add UI (backoffice pages)

Two kinds of UI in this repo - pick the right one for your change:

- **Module-scoped UI** (a screen tightly coupled to one module's domain) -> `packages/modules/<group>/<name>/ui/`. Import only from `@oss/ui-provider-contract`. Use the DataTable component for lists, Form for create/edit. The module's plugin mounts it via UI slots.
- **Cross-cutting admin page** (dashboard, users, games) -> add to `packages/sdks/react-sdk/src/pages/admin/`, export from `index.ts`, then add a TanStack route file under `apps/backoffice/src/routes/_authed/<route>.tsx` (use `createFileRoute('/_authed/<route>')`). A **player page** goes in `src/pages/player/` with a Next route shim in `apps/web/app/<route>/page.tsx`. `@oss/react-sdk` is consumed by both reference apps and by downstream consumers. See `packages/sdks/react-sdk/AGENTS.md` and ADR-0005.
- **A plugin-contributed admin extension** (column, tile, nav item, route - not a core page) -> use a client-side `defineUIPlugin` instead of editing react-sdk. See ADR-0006.

## Step 10: Update AGENTS.md

Edit `packages/modules/<group>/<name>/AGENTS.md`. Fill in:

- What the module does (one paragraph).
- Extension points (ports, events emitted/consumed, UI slots, routes).
- Do / don't list.
- Sample diff showing how to add a route.
- A "Done when:" checklist the next agent can self-verify against.

## Step 11: Verify

```
/verify --filter @oss/modules
```

Fix any typecheck, lint, boundary, or test failures before considering the work done.

## Step 12: Integration check

Start the full stack:

```
pnpm dev
```

Call a route manually to confirm end-to-end wiring:

```
curl -X POST http://localhost:3001/<name>s -H "Content-Type: application/json" -d '{"tenantId":"test"}'
```

## Common pitfalls

- Forgetting `pnpm regen` after editing `src/schema/index.ts` - the migration and generated types will be stale.
- Importing from another module directly - use events or read its tables via the `@oss/modules/<group>/<name>/schema` subpath. Boundary lint will reject a cross-module source import.
- Defining schemas inline in handlers - they must live in `schemas/`.
- Hand-editing the generated migrations under `packages/platform/db/` - they are produced by `pnpm regen` (drizzle-kit). The source of truth is each module's `src/schema/index.ts`.
- Opening a PR with a failing `pnpm verify` - CI will reject it.

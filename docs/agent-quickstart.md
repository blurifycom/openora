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
/scaffold-module <name>
```

This creates `packages/addons/<name>/` (a new add-on package) with all required files and registers it in `extensions.config.ts`.

## Step 4: Define the Drizzle tables

Edit `packages/addons/<name>/src/schema/index.ts` (core modules: `packages/core/src/<domain>/<module>/schema/index.ts` - no `src/` segment). Add `pgTable` definitions following these rules:

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

Edit the module's `contract/` dir (`packages/addons/<name>/src/contract/index.ts`; core modules: `packages/core/src/<domain>/<module>/contract/index.ts`). It owns the route contract plus the request/response schemas and their `z.infer`'d types. Check if a shared schema already exists:

```
schema-get name=<EntityName>
query-openapi keyword="<entity>"
```

If a shared schema exists in `@openora/core/contracts`, re-export it instead of duplicating.

## Step 6: Implement the service

Edit `packages/addons/<name>/src/service/<name>.service.ts` (core modules: `packages/core/src/<domain>/<module>/service/<name>.service.ts`). Business logic only. Rules:

- Take `DrizzleService` (from `@openora/core/server`) + `EventBus` as constructor arguments (the module plugin builds the service from the container). Query with `this.drizzle.db.select().from(<table>).where(eq(...))`; import operators (`eq`, `desc`, `sql`) from `drizzle-orm` and tables from `../schema/index.js`.
- Throw domain errors via `createDomainError(...)` from `@openora/core`.
- Never call external HTTP APIs directly - use an adapter interface from `@openora/core/contracts`.

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

Edit `packages/addons/<name>/src/plugin.ts` (core modules: `packages/core/src/<domain>/<module>/plugin.ts`). Confirm the service is added to `ctx.providers` and the router is added to `ctx.routers`. The registry surface is: `providers`, `controllers`, `routers`, `slots`, `events`, `mcp`, `imports`.

## Step 9: Add frontend consumption layer

The platform is headless backend only - pages, components, and styling live in the downstream consumer repo. What you can add to the OSS:

- **A new data hook** (eg `useAdminUsers`, `usePlayerWallet`) -> `packages/core/src/react/src/hooks/`. `@openora/core/react` is the supported frontend consumption surface (data hooks, auth, realtime transport - no components).

## Step 10: Update AGENTS.md

Edit `packages/addons/<name>/AGENTS.md` (core modules: `packages/core/src/<domain>/<module>/AGENTS.md`). Fill in:

- What the module does (one paragraph).
- Extension points (ports, events emitted/consumed, UI slots, routes).
- Do / don't list.
- Sample diff showing how to add a route.
- A "Done when:" checklist the next agent can self-verify against.

## Step 11: Verify

```
/verify --filter @openora/core
```

Fix any typecheck, lint, boundary, or test failures before considering the work done.

## Step 12: Integration check

Start the full stack:

```
pnpm dev
```

Call a route manually to confirm end-to-end wiring:

```
curl -X POST http://localhost:3001/<name>s -H "Content-Type: application/json" -d '{}'
```

## Common pitfalls

- Forgetting `pnpm regen` after editing `src/schema/index.ts` - the migration and generated types will be stale.
- Importing from another module directly - use events or read its tables via the `@openora/core/<domain>/schema` subpath. Both boundary gates reject it: the oxlint `oss-boundaries/*` plugin (per-edit, specifier strings) and the whole-graph `pnpm boundaries` gate (catches transitive / re-export / dynamic-import / relative-path dodges too).
- Introducing an import cycle - rejected by `import/no-cycle` and the whole-graph `no-circular` gate. Break it by extracting a shared module, inverting a dependency, or moving the type to a contracts package.
- Declaring `interface` - use `type` (lint-enforced).
- Defining schemas inline in handlers - they must live in the module's `contract/` dir.
- Hand-editing the generated migrations - they are produced by `pnpm regen` (drizzle-kit). The source of truth is each module's `src/schema/index.ts`.
- Opening a PR with a failing `pnpm verify` - CI will reject it.

# Agent Quickstart

This guide walks an AI agent through implementing a module end-to-end using only slash commands and the MCP dev server. Human involvement: review + approve the PR.

## Assumptions

- `pnpm setup:agent` has been run (Docker up, DB migrated, dependencies installed).
- The MCP dev server is running: `pnpm -F @oss/mcp-server-dev dev`.
- Claude Code is connected to the `oss-dev` MCP server.

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

This creates `packages/modules/<name>/` with all required files and registers in `extensions.config.ts`.

## Step 4: Define the Prisma schema

Edit `packages/modules/<name>/prisma.partial.prisma`. Add models following these rules:

- Every multi-tenant model has `tenantId  String`.
- No FK references to models owned by other modules (use IDs).
- Use PascalCase singular model names.

Check for table name collisions before adding:

```
propose-prisma-change model=<ModelName>
```

Then regenerate:

```
/regen
```

## Step 5: Define schemas

Edit `packages/modules/<name>/src/schemas/index.ts`. Define Zod schemas for the module's entities. Check if a shared schema already exists:

```
query-openapi keyword="<entity>"
```

If a shared schema exists in `@oss/contracts/domain-schemas`, re-export it instead of duplicating.

## Step 6: Implement the service

Edit `packages/modules/<name>/src/service/<name>.service.ts`. Business logic only. Rules:

- Receive PrismaClient + EventBus via constructor.
- Throw domain errors (eg `class EntityNotFoundError extends Error {}`).
- Never call external HTTP APIs directly - use a port interface from `ports.ts`.

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

Edit `packages/modules/<name>/src/plugin.ts`. Confirm the service is added to `ctx.providers` and the router is added to `ctx.routers`.

## Step 9: Add UI (backoffice pages)

Two kinds of UI in this repo - pick the right one for your change:

- **Module-scoped UI** (a screen tightly coupled to one module's domain) -> `packages/modules/<name>/ui/`. Import only from `@oss/ui-provider-contract`. Use the DataTable component for lists, Form for create/edit. The module's plugin mounts it via UI slots.
- **Cross-cutting backoffice page** (dashboard, users, games - the admin shell itself) -> add to `packages/sdks/react-sdk/src/pages/`, export from `index.ts`, then add a Next route shim in `packages/sdks/react-sdk/examples/backoffice/app/(authed)/<route>/page.tsx`. `@oss/react-sdk` is consumed both by the reference example app and by downstream consumers like Consumer. See `packages/sdks/react-sdk/AGENTS.md` and ADR-0005.
- **A plugin-contributed admin extension** (column, tile, nav item, route - not a core page) -> use a client-side `defineUIPlugin` instead of editing react-sdk. See ADR-0006.

## Step 10: Update AGENTS.md

Edit `packages/modules/<name>/AGENTS.md`. Fill in:

- What the module does (one paragraph).
- Extension points (ports, events emitted/consumed, UI slots, routes).
- Do / don't list.
- Sample diff showing how to add a route.

## Step 11: Verify

```
/verify --filter @oss/module-<name>
```

Fix any typecheck, lint, or test failures before considering the work done.

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

- Forgetting `pnpm regen` after changing `prisma.partial.prisma` - types will be stale.
- Importing from another module directly - use events instead.
- Defining schemas inline in handlers - they must live in `schemas/`.
- Editing `infra/prisma/schema.prisma` directly - it's overwritten by `pnpm regen`.
- Opening a PR with a failing `pnpm verify` - CI will reject it.

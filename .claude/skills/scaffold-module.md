---
name: scaffold-module
description: Generate a new OSS module from template. Creates schema, service, router, plugin.ts, AGENTS.md and registers in extensions.config.ts.
---

Run `pnpm scaffold module $ARGUMENTS` in the repo root. Modules are grouped, so the args are
`<group> <name>` where group is `player`, `backoffice`, or `platform` (player-facing / admin /
shared substrate). Example: `pnpm scaffold module player tournaments`.

After the scaffolder finishes (module lands at `packages/modules/<group>/<name>/`):

1. Open `<group>/<name>/src/plugin.ts` and verify the module ID + that any default adapter
   bindings the module needs are present (`ctx.provide(SOME_TOKEN, () => new DefaultImpl())`).
2. Open `<group>/<name>/src/schema/index.ts` and define the Drizzle tables (`pgTable(...)`).
   Every multi-tenant table needs a `tenantId` column.
3. Open `<group>/<name>/src/schemas/index.ts` (or `shared-schemas`) and define the Zod input
   and output schemas for the module's routes.
4. Open `<group>/<name>/src/service/<name>.service.ts` and sketch the business logic. Inject
   adapters + `DRIZZLE` + `EVENT_BUS` via the constructor; never inline fetch / SQL.
5. Open `<group>/<name>/src/router/index.ts` and add the oRPC routes (input + output schemas
   imported from step 3). Admin routes call `await adminGuard.assert(context)` first.
6. Run `pnpm regen` to regenerate the OpenAPI spec, the Drizzle client, and the catalog. Then
   `pnpm -F @oss/db exec drizzle-kit generate --name add-<name>-tables` to emit the migration.
7. Run `pnpm verify` to check types, lint (boundaries, module shape), and unit tests.

Tell the user what was generated and what they need to fill in next. The scaffolder marks
edit regions with `// AGENT: implement here` - fill those; leave the wiring alone.

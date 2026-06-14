---
targets:
  - '*'
description: 'Generate a new OSS add-on via turbo gen. Creates schema, service, router, plugin.ts, a working `list` route + contract slice, AGENTS.md, and registers in extensions.config.ts.'
---

Run `pnpm gen module $ARGUMENTS` in the repo root (the single `turbo gen` surface). The args are
`<name>` (eg `tournaments`). The add-on is automatically registered as a core add-on (always loaded, contract in `@oss/orpc-contract`).

The scaffold ships a buildable add-on - a `list` route wired end to end (contract slice ->
router -> service) over a `tenantId` table - so `pnpm regen && pnpm verify` is green
immediately. Extend from there. After the generator finishes (add-on at `packages/addons/<name>/`):

1. Open `<name>/src/plugin.ts` and verify the module ID + that any default adapter
   bindings the add-on needs are present (`ctx.provide(SOME_TOKEN, () => new DefaultImpl())`).
2. Open `<name>/src/schema/index.ts` and define the Drizzle tables (`pgTable(...)`).
   Every multi-tenant table needs a `tenantId` column.
3. Open `<name>/src/schemas/index.ts` (or `shared-schemas`) and define the Zod input
   and output schemas for the add-on's routes.
4. Open `<name>/src/service/<name>.service.ts` and sketch the business logic. Inject
   adapters + `DRIZZLE` + `EVENT_BUS` via the constructor; never inline fetch / SQL.
5. Open `<name>/src/router/index.ts` and add the oRPC routes (input + output schemas
   imported from step 3). Admin routes call `await adminGuard.assert(context)` first.
6. Run `pnpm regen` - regenerates the OpenAPI spec, the Drizzle client, the table migration,
   the RLS tenant-isolation policy for any new `tenantId` table (auto, via `gen:rls`), and the
   catalog. No manual drizzle-kit step.
7. Run `pnpm verify` to check types, lint (boundaries, module shape), and unit tests.

Tell the user what was generated and what they need to fill in next. The generator marks
edit regions with `// AGENT: implement here` - fill those; leave the wiring alone.

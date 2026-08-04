---
targets:
  - '*'
description: 'Generate a new OSS module via turbo gen. Creates schema, contract, service, router, plugin.ts, a working `list` route, AGENTS.md, and wires the domain barrels, @openora/core exports, contract slice, and extensions.config.ts.'
---

Run `pnpm gen module $ARGUMENTS` (args: `<domain> <name>`, eg `casino tournaments`) in the repo root. The module lands in `packages/core/src/<domain>/<name>/`; the domain may be new.

The scaffold ships a buildable module - a `list` route wired end to end (contract -> router -> service) over a sample table - so `pnpm regen && pnpm verify` is green immediately. The generator marks edit regions with `// AGENT: implement here` - fill those, leave the wiring alone:

1. `plugin.ts` - verify the module id + any default adapter bindings (`ctx.provide(TOKEN, () => new DefaultImpl())`).
2. `schema/index.ts` - Drizzle tables (`propose-table-change` via MCP first; see `docs/standards/database.md`).
3. `contract/index.ts` - Zod input/output schemas for the routes (the single source of wire truth).
4. `service/<name>.service.ts` - business logic; inject `DRIZZLE` + `EVENT_BUS` + adapter ports via the constructor; never inline fetch/SQL. Audit every mutation.
5. `router/index.ts` - oRPC routes with imported schemas; admin routes call `await adminGuard.assert(context)` first.
6. `pnpm regen` (migration + catalog), then `pnpm verify`.

Tell the user what was generated and what remains to fill in.

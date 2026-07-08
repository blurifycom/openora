---
description: 'Generate an overlay extension under apps/api/src/extensions/<name>/. Adds routes, providers, event handlers, or MCP tools without touching @openora/* core. Args: <name>.'
---

Run `pnpm gen plugin $ARGUMENTS` in the repo root. For a vendor swap use
`pnpm gen adapter <name> <TOKEN> <dependsOn>`; for a react-sdk page use `pnpm gen page <route>`.

After the generator finishes, open `apps/api/src/extensions/<name>/plugin.ts` and implement
`register(ctx)`:

- `ctx.provide(TOKEN, factory)` - bind an adapter/service (sealed compliance tokens are rejected at
  compile + runtime).
- `ctx.routers.add(namespace, (c) => router)` - mount oRPC routes (Zod input/output, no inline schemas).
- `ctx.events.on(event, handler)` - subscribe to the typed `EventBus`.
- `ctx.mcp.tool(definition)` - expose an MCP tool.

Then:

1. Register the plugin in `apps/api/src/extensions.config.ts`. Last registration of a DI token wins -
   list an adapter swap AFTER the module that owns the default binding.
2. Tables go in the overlay's own `src/schema/index.ts` (follow `db-conventions`); run `pnpm db:migrate`.
3. Audit every state-changing action (emit an event the `audit` add-on consumes, or `AUDIT_WRITER.record`).
4. `/check` to confirm wiring compiles and boundary lint passes.

Prefer the guided **create-plugin** skill for the full interview -> classify -> wire -> verify loop.

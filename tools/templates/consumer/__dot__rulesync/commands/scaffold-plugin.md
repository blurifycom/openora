---
targets: ['*']
description: 'Generate an overlay extension under apps/api/src/extensions/<name>/. Adds routes, providers, event handlers, agent tools, or agent action types without touching @openora/* core. Args: <name>.'
---

Run `pnpm gen plugin $ARGUMENTS` in the repo root. For a vendor swap use
`pnpm gen adapter <name> <TOKEN> <dependsOn>`; for a react-sdk page use `pnpm gen page <route>`.

After the generator finishes, open `apps/api/src/extensions/<name>/plugin.ts` and implement
`register(ctx)`:

- `ctx.provide(TOKEN, factory)` - bind an adapter/service (sealed compliance tokens are rejected at
  compile + runtime).
- `ctx.routers.add(namespace, (c) => router)` - mount oRPC routes (Zod input/output, no inline schemas).
- `ctx.events.on(event, handler)` - subscribe to the typed `EventBus`.
- `ctx.mcp.tool(defineMcpTool({...}), (c) => async (input, run) => output)` - register an agent tool,
  a read a model makes during a run.
- `ctx.actions.register(defineActionType({...}), (c) => ({ precondition, execute }))` - register an
  agent action type, a change a model may only propose. `execute` performs nothing on a replay
  while its effect still holds, and answers `already_applied`.

Both are served only through the `MCP_KERNEL` token, which checks IAM, validates input, applies the
output allow-list and audits every tool call and action execution; a shape it cannot serve fails
boot with the fix. The one-argument `ctx.mcp.tool(definition)` still registers but the kernel does
not serve it.

Then:

1. Register the plugin in `apps/api/src/extensions.config.ts`. Last registration of a DI token wins -
   list an adapter swap AFTER the module that owns the default binding.
2. Tables go in the overlay's own `src/schema/index.ts` (follow `docs/standards/database.md`); run `pnpm db:migrate`.
3. Audit every state-changing action (emit an event the `audit` add-on consumes, or `AUDIT_WRITER.record`).
4. `/check` to confirm wiring compiles and boundary lint passes.

Prefer the guided **create-plugin** skill for the full interview -> classify -> wire -> verify loop.

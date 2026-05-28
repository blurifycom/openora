---
name: scaffold-plugin
description: Generate a new overlay extension plugin under apps/api/src/extensions/<name>/. The plugin can add routes, providers, UI slots, event handlers, and MCP tools without modifying core modules.
---

Run `pnpm scaffold plugin $ARGUMENTS` in the repo root.

After the scaffolder finishes:

1. Open `apps/api/src/extensions/<name>/plugin.ts` and implement the server `register(ctx)`: `ctx.provide(TOKEN, factory)`, `ctx.routers.add(namespace, (c) => router)`, `ctx.slots.fill(slotName, component)`, `ctx.events.on(event, handler)`, `ctx.mcp.tool(definition)`. Tables go in the overlay's own `src/schema/index.ts` (Drizzle `pgTable`) - there is no `ctx.prisma`.
2. For admin UI extension, add a separate `ui.tsx` exporting `defineUIPlugin({ id, register(ctx) })` from `@oss/react-sdk` and pass it to the consumer's `<UIPluginProvider plugins={[...]}>`. UI slots: `ctx.nav`, `ctx.dashboard.tiles`, `ctx.users.columns/toolbar`, `ctx.userDetail.sections/actions`, `ctx.games.columns`, `ctx.routes`. See ADR-0006.
3. Run `pnpm verify` to check the wiring compiles.

Explain both the server `ctx` (from `@oss/plugin-host` ModuleRegistry) and the UI `ctx` (from the `defineUIPlugin` registry). The two are separate files sharing an `id`.

---
name: scaffold-plugin
description: Generate a new overlay extension plugin under apps/extensions/<name>/. The plugin can add routes, providers, UI slots, event handlers, and MCP tools without modifying core modules.
---

Run `pnpm scaffold plugin $ARGUMENTS` in the repo root.

After the scaffolder finishes:

1. Open `apps/extensions/<name>/plugin.ts` and implement the server `register(ctx)`: `ctx.routers.add(...)`, `ctx.providers.add(...)`, `ctx.events.on(...)`, `ctx.prisma.extend(...)`, `ctx.mcp.tool(...)`.
2. For admin UI extension, add a separate `ui.tsx` exporting `defineUIPlugin({ id, register(ctx) })` from `@oss/react-sdk` and pass it to the consumer's `<UIPluginProvider plugins={[...]}>`. UI slots: `ctx.nav`, `ctx.dashboard.tiles`, `ctx.users.columns/toolbar`, `ctx.userDetail.sections/actions`, `ctx.games.columns`, `ctx.routes`. See ADR-0006.
3. Run `pnpm verify` to check the wiring compiles.

Explain both the server `ctx` (from `@oss/plugin-host` ModuleRegistry) and the UI `ctx` (from the `defineUIPlugin` registry). The two are separate files sharing an `id`.

---
name: scaffold-plugin
description: Generate a new overlay extension plugin under apps/api/src/extensions/<name>/. The plugin can add routes, providers, UI slots, event handlers, and MCP tools without modifying core modules.
---

Run `pnpm scaffold plugin $ARGUMENTS` in the repo root.

After the scaffolder finishes:

1. Open `apps/api/src/extensions/<name>/plugin.ts` and implement the server `register(ctx)`:
   - `ctx.provide(TOKEN, factory)` to bind an adapter or service (sealed compliance tokens
     are rejected at compile time + runtime - see `@oss/compliance-invariants`).
   - `ctx.routers.add(namespace, (c) => router)` to mount oRPC routes.
   - `ctx.events.on(event, handler)` to subscribe to the typed `EventBus`.
   - `ctx.jobs.worker({ queue, schema, handler, options?, onDeadLetter? })` to process
     background jobs off the `JOB_QUEUE` seam (see ADR-0014). For a `<name>-worker` overlay,
     register the handler here; enqueue from a service via the resolved `JOB_QUEUE`
     (`enqueue(queue('name'), payload, { idempotencyKey, delayMs, attempts, backoff })`).
     The default driver is in-process; the `bullmq` overlay makes it durable when
     `REDIS_URL` is set. Handlers must be idempotent (delivery is at-least-once).
   - `ctx.mcp.tool(definition)` to expose a new MCP tool.

   Tables go in the overlay's own `src/schema/index.ts` (Drizzle `pgTable`). Last registration
   of a token wins, so an overlay loaded after the default-binding module replaces that
   default - keep the override order intentional in `extensions.config.ts`.

2. For admin / player UI extension, add a separate `ui.tsx` exporting
   `defineUIPlugin({ id, register(ctx) })` from `@oss/react-pages` and pass it to the
   consumer's `<OssProviders plugins={[...]} features={{...}}>`. UI slots are typed:
   `ctx.nav`, `ctx.dashboard.tiles`, `ctx.users.columns/toolbar`,
   `ctx.userDetail.sections/actions`, `ctx.playerDetail.sections/actions`, `ctx.games.columns`,
   `ctx.playerLobby.ribbon`, `ctx.playerGameTile.decorator`, `ctx.routes`. Slot fills accept
   optional gating props: `visibleWhen`, `requiresPermission`, `brandScope`, `featureFlag`.
   See ADR-0013.

3. For shared page data, host pages mount `<PageContextProvider value={...}>` and slot fills
   read it with `usePageContext<T>()` (from `@oss/react-hooks`). For plugin-injected data,
   use `useDataExtension(pluginId, key, fetcher, args?)` - the cache key is namespaced so
   two plugins reading the same `(pluginId, key, args)` share one fetch.

4. Run `pnpm verify` to check the wiring compiles and the boundary lint passes.

Explain both the server `ctx` (from `@oss/plugin-host` ModuleRegistry) and the UI `ctx`
(from the `defineUIPlugin` registry). The two are separate files sharing an `id`.

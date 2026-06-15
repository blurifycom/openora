---
targets:
  - '*'
description: 'Generate a new overlay extension plugin under apps/api/src/extensions/<name>/. The plugin can add routes, providers, UI slots, event handlers, and MCP tools without modifying core modules.'
---

Run `pnpm gen plugin $ARGUMENTS` in the repo root. For a vendor-adapter swap use `pnpm gen adapter <name> <TOKEN> <dependsOn>`; for a
background-job worker use `pnpm gen job-worker <name>`.

After the generator finishes:

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

   This repo is headless - plugins are server-side only. UI extensions (`defineUIPlugin`,
   nav/column/tile/section slots) live in the frontend repo, not here.

2. Run `pnpm verify` to check the wiring compiles and the boundary lint passes.

Explain the server `ctx` (from `@oss/plugin-host` ModuleRegistry) - the single `plugin.ts`
surface a server plugin exposes.

---
targets:
  - '*'
description: 'Generate a new overlay extension plugin under extensions/<name>/. Adds routes, providers, event handlers, job workers, and MCP tools without modifying core modules.'
---

Run `pnpm gen plugin $ARGUMENTS` in the repo root. Variants: `pnpm gen adapter <name> <TOKEN> <dependsOn>` for a vendor-adapter swap; `pnpm gen job-worker <name>` for a background-job worker.

The generator creates `extensions/<name>/plugin.ts` and registers it in `extensions.config.ts`. Then implement `register(ctx)`:

- `ctx.provide(TOKEN, factory)` - bind/override an adapter or service. Last registration wins, so an overlay loaded after the default-binding module replaces the default - keep the order in `extensions.config.ts` intentional. Sealed compliance tokens (`@blurifycom/core/compliance`) are rejected at compile time + runtime.
- `ctx.routers.add(namespace, (c) => router)` - mount oRPC routes.
- `ctx.events.on(topic, handler)` - subscribe to the typed `EventBus`.
- `ctx.jobs.worker({ queue, schema, handler, onDeadLetter? })` - process jobs off the `JOB_QUEUE` seam (ADR-0014). Enqueue from a service via `enqueue(queue('name'), payload, { idempotencyKey, delayMs, attempts, backoff })`. Handlers must be idempotent (at-least-once).
- `ctx.mcp.tool(definition)` - expose a new MCP tool.

Tables go in the plugin's own `schema/index.ts` (Drizzle `pgTable`), then `pnpm regen`.

This repo is headless - plugins are server-side only; UI extensions live in the consumer frontend.

Finish with `pnpm verify` (wiring compiles, boundary lint passes) and tell the user what was generated and what to fill in.

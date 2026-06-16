# Extensions (overlay plugins)

In-tree overlay plugins live here. Each subfolder is a self-contained extension that adds or overrides platform functionality without modifying a core module.

This is the same location consumer projects use (the `pnpm create:app` scaffolder emits `apps/api/src/extensions/` too), so the overlay-authoring story is identical in OSS and downstream.

## How to add an extension

```bash
/scaffold-plugin <name>
```

Or manually:

```
apps/api/src/extensions/<name>/
  plugin.ts        # exports `default definePlugin({ id, register })`
  package.json     # name: extension-<name>  (optional - only if published)
  AGENTS.md        # what it does, hooks, extension points
  src/schema/index.ts   # optional: the overlay's own Drizzle pgTable definitions
```

## How it works

1. Register the overlay in repo-root `extensions.config.ts` (append at the bottom under the "Overlay extensions" comment).
2. `packages/core/src/server/plugin-host` loads every registered entry at API boot, in top-to-bottom order (respecting `dependsOn`).
3. `register(ctx)` receives a `ModuleRegistry`. Use it to bind providers, mount routers, fill UI slots, subscribe to events, expose MCP tools.

See `AGENTS.md` in this directory for the full `ctx` surface and the do/don't.

## Boundary rules

- An overlay may import any `@oss/*` package.
- An overlay may NOT import another extension. Cross-extension communication goes through the event bus.
- Import a package entry (eg `@oss/modules/player/wallet/schema`), never a deep `dist/` path.

# Extensions (Overlay Plugins)

Drop in-tree overlay plugins here. Each subfolder is a self-contained extension that adds or overrides platform functionality without modifying core modules.

## How to add an extension

```bash
/scaffold-plugin <name>
```

Or manually:

```
apps/extensions/<name>/
  plugin.ts        # exports default definePlugin({ id, register })
  package.json     # name: extension-<name>
  AGENTS.md        # what it does, hooks, extension points
  src/schema/index.ts   # optional: the overlay's own Drizzle pgTable definitions
```

## How it works

1. Register in `extensions.config.ts` at the repo root.
2. `packages/platform/plugin-host` loads all registered plugins at API boot time.
3. The `register(ctx)` function receives a `ModuleRegistry` — use it to add routes, providers, UI slots, event handlers, and MCP tools.

## Boundary rules

- Extensions may import from any `@oss/*` package.
- Extensions may NOT import from other extensions.
- Cross-extension communication: emit events and subscribe.

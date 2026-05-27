# ADR-0002: definePlugin + overlay as the extension mechanism

**Date**: 2026-05-18
**Status**: Accepted

## Context

The platform's primary value proposition is extensibility: operators clone the repo and add their own games, payment providers, custom pages, and business rules without forking core. We need a mechanism that:

- Is transparent (greppable, no magic discovery).
- Supports in-tree modifications (for operators who want full control) AND npm-package distribution (for reusable add-ons).
- Works well for AI agents authoring extensions (templates + typed contracts help).
- Doesn't require modifying core files to add a feature.

## Decision

**Primary path - in-tree overlay**: Drop a folder under `apps/extensions/<name>/` with a `plugin.ts` exporting `definePlugin`. Register in `extensions.config.ts`. At API boot, the plugin host loads plugins in dependency order.

**Secondary path - npm package**: Same `definePlugin` contract. Listed in `extensions.config.ts` with an npm package name instead of a path.

The `definePlugin` factory returns a typed `Plugin` object. The `register(ctx: ModuleRegistry)` function receives a registry that exposes typed methods: `ctx.provide`, `ctx.routers.add`, `ctx.slots.fill`, `ctx.events.on`, `ctx.mcp.tool`.

> **Update (2026-05):** the Drizzle migration removed `ctx.prisma.extend`. Overlays now add their own `pgTable` in their module's `src/schema/index.ts`; the plugin registry no longer exposes a `prisma` surface.

Inspired by: OpenMercato's overlay pattern (in-tree, no core patching), Payload v3's `definePlugin` (ordered, slug-keyed, typed options).

## Consequences

**Positive:**

- `extensions.config.ts` is the single registry - audit what runs by reading one file.
- Overlays live in-repo so AI agents can scaffold and modify them without publishing packages.
- `dependsOn` array enables topological sort; load order is explicit and deterministic.
- Plugins can extend the Prisma schema via partials - no ORM lock-in for extensions.

> **Update (2026-05):** after the Drizzle migration there are no Prisma partials. A plugin adds its own `pgTable` defs in its module's `src/schema/index.ts`; drizzle-kit globs them at `pnpm regen`.

**Negative / trade-offs:**

- In-tree overlays don't get npm versioning. Operators must manage updates manually or git-subtree the overlay.
- Core modules are also plugins (`packages/modules/<name>/src/plugin.ts`), so the system boots entirely through the plugin host. If the plugin host has a bug, nothing starts. Mitigation: comprehensive integration tests on the host.

**Neutral:**

- Naming: "plugin" and "extension" are used interchangeably in this codebase. The formal type is `Plugin`; the in-tree variant is called an "overlay" to distinguish it from npm-published plugins.

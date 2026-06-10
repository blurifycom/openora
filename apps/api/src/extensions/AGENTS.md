# AGENTS.md - overlay extensions

Brief for an agent authoring an overlay plugin under `apps/api/src/extensions/<name>/`. This is the primary way to add or override behavior **without** modifying a core module. Read this before editing here; the root `AGENTS.md` has the platform-wide rules.

## When to write an overlay (vs a module)

- New self-contained business domain -> a module (`/scaffold-module <group> <name>`), not an overlay.
- Extend / override an existing module, bind a vendor adapter, fill a UI slot, subscribe to events, or add tables that decorate an existing surface -> an overlay here.

## Scaffold

```
/scaffold-plugin <name>
```

Creates `apps/api/src/extensions/<name>/plugin.ts` and appends an entry to `extensions.config.ts`.

## The `register(ctx)` surface

`definePlugin({ id, dependsOn?, register(ctx) })`. `ctx` is a `ModuleRegistry` (see `packages/platform/plugin-host/src/define-plugin.ts`):

| Hook                                        | Use                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.provide(TOKEN, factory)`               | Bind a vendor / service factory to a typed token. **Last registration wins** - so an overlay loaded after a module can rebind that module's adapter token. |
| `ctx.routers.add(namespace, (c) => router)` | Mount new oRPC routes under a namespace. The factory receives the resolved `Container` so it can pull services / adapters by token.                        |
| `ctx.slots.fill(slotName, component)`       | Inject server-declared UI into a named admin shell slot.                                                                                                   |
| `ctx.events.on(event, handler)`             | Subscribe to a domain event (see `docs/CATALOG.md` for the catalogue).                                                                                     |
| `ctx.mcp.tool(definition)`                  | Expose a new MCP dev tool to the agent surface.                                                                                                            |

There is no `ctx.providers.add`, no `ctx.imports`, no `ctx.prisma`. The platform is built on the functional composition `Container` from `@oss/core`, not NestJS - those Nest-era hooks are gone. Tables live in your overlay's own `src/schema/index.ts` (Drizzle `pgTable`); run `pnpm regen` after.

## Binding / overriding a vendor adapter

Implement an interface from `@oss/adapters` (see `docs/CATALOG.md` > Adapter seams for the list and which are wired vs stub), then in `register(ctx)`:

```ts
import { PAYMENT_ADAPTER } from '@oss/adapters';
import { MyStripeAdapter } from './my-stripe-adapter';

ctx.provide(PAYMENT_ADAPTER, () => new MyStripeAdapter());
```

**Override semantics**: the Container takes the last-registered factory for a token. So to override a module's default binding (eg wallet's `MockPaymentAdapter`), the overlay must appear AFTER that module in `extensions.config.ts`. The `/scaffold-plugin` skill appends new overlays at the end, so a fresh overlay already loads after the core modules.

## Adding tables (optional)

Put a `pgTable` in the overlay's `src/schema/index.ts`. Run `pnpm regen` to generate the migration. Read another module's tables via the subpath import `@oss/modules/<group>/<name>/schema` - never a deep `dist/` path.

## Boundary rules (enforced by `pnpm verify`)

- An overlay may import any `@oss/*` package.
- An overlay may NOT import another extension. Cross-extension comms go through `ctx.events`.
- Import a package entry (eg `@oss/modules/player/wallet/schema`), never a deep `dist/` path.

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- The overlay is listed by `list-modules` and its routes by `list-routes` (via the MCP dev server).
- If you bound an adapter, `docs/CATALOG.md` (after `pnpm regen`) shows the seam wired.

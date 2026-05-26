# AGENTS.md - Overlay extensions

Brief for an agent authoring an overlay plugin under `apps/extensions/<name>/`. This is
the primary way to add or override behavior WITHOUT modifying a core module. Read this
before editing here; the root `AGENTS.md` has the platform-wide rules.

## When to write an overlay (vs a module)

- New self-contained business domain -> a module (`/scaffold-module`), not an overlay.
- Extend/override an existing module, bind a vendor adapter, add a UI slot fill, subscribe
  to events, or add tables that decorate an existing surface -> an overlay here.

## Scaffold

```
/scaffold-plugin <name>
```

Creates `apps/extensions/<name>/plugin.ts` and registers it in `extensions.config.ts`.

## The register(ctx) surface

`definePlugin({ id, dependsOn?, register(ctx) })`. `ctx` (ModuleRegistry) exposes exactly:

| Hook | Use |
| --- | --- |
| `ctx.providers.add(provider)` | add a Nest provider (service, or `{ provide: TOKEN, useClass }`) |
| `ctx.controllers.add(Controller)` | add an oRPC `@Implement` controller |
| `ctx.routers.add(namespace, router)` | mount new oRPC routes |
| `ctx.slots.fill(name, component)` | inject server-declared UI (admin shell slots) |
| `ctx.events.on(event, handler)` | subscribe to a domain event (see docs/CATALOG.md) |
| `ctx.mcp.tool(def)` | expose a new MCP dev tool |
| `ctx.imports.add(NestModule)` | import a whole Nest module |

There is NO `ctx.prisma`. To add tables, define your own `pgTable` in the overlay's
`src/schema/index.ts` and run `pnpm regen`. To decorate another module's data, add your
own table keyed by that entity's id (no cross-module FK).

## Binding / overriding a vendor adapter

Implement an interface from `@oss/adapters` (see `docs/CATALOG.md` > Adapter seams for the
list and which are wired vs stub), then:

```ts
ctx.providers.add({ provide: PAYMENT_ADAPTER, useClass: MyStripeAdapter });
```

Override semantics: Nest takes the LAST-registered provider for a token. So to override a
module's default binding (eg wallet's `MockPaymentAdapter`), your overlay must appear AFTER
that module in `extensions.config.ts`. The scaffolder appends new overlays at the end, so a
fresh overlay already loads after the core modules.

## Boundary rules (enforced by `pnpm verify`)

- An overlay may import any `@oss/*` package.
- An overlay may NOT import another extension. Cross-extension comms go through events.
- Import the package entry (eg `@oss/modules/player/wallet/schema`), never a deep `dist/` path.

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- The overlay is listed by `list-modules` and its routes by `list-routes`.
- If you added an adapter binding, `docs/CATALOG.md` (after `pnpm regen`) shows the seam wired.

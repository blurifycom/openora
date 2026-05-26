# Architecture

How the platform fits together: the contract spine, the plugin host that loads
everything, the adapter seams that keep it swappable, and how a downstream
consumer (Consumer) reuses it without forking.

For the rationale behind each choice, see the [ADRs](./adr/). For the rules an
agent must follow, see [AGENTS.md](../AGENTS.md).

## System overview

```mermaid
flowchart TB
  subgraph contracts["Contracts - the source of truth"]
    zod["shared-schemas<br/>single Zod root"]
    orpc["orpc-contract<br/>composed oRPC router"]
    openapi["docs/openapi.json<br/>(emitted)"]
    client["typed client<br/>(zero codegen)"]
    zod --> orpc
    orpc --> openapi
    orpc --> client
  end

  subgraph runtime["API runtime - apps/api calls createApp()"]
    cfg["extensions.config.ts<br/>plugin registry"]
    host["plugin-host<br/>definePlugin / ModuleRegistry"]
    nest["NestJS + @orpc/nest<br/>DI, guards, validation, OpenAPI emit"]
    cfg --> host
    host --> nest
    orpc --> nest
  end

  subgraph platform["Platform services (packages/platform/*)"]
    db["@oss/db<br/>Drizzle client + migrations + tenant scope"]
    auth["auth<br/>better-auth + AdminGuard"]
    core["core<br/>logger, tenant ctx, EventBus"]
  end

  subgraph modules["Business modules (packages/modules/*)"]
    mod["identity, wallet, gaming, lobby, bonus,<br/>compliance, chat, cms, backoffice, player ..."]
    adapters["@oss/adapters<br/>vendor adapter interfaces"]
    mod --> adapters
  end

  vendor["Vendor adapters<br/>PSP, KYC, aggregator, chat"]
  worker["worker (apps/worker)<br/>BullMQ event handlers"]

  host --> mod
  nest --> auth
  mod --> db
  mod --> core
  core -. events .-> worker
  adapters -. implemented by .-> vendor

  subgraph ui["Headless UI"]
    uic["ui-provider-contract<br/>component interface"]
    shad["ui-provider-shadcn<br/>default adapter"]
    sdk["react-sdk<br/>typed client, hooks, theme, app shell, pages"]
    uiplug["UI plugin registry<br/>defineUIPlugin"]
    shad -. implements .-> uic
    sdk --> uic
    uiplug --> sdk
  end
  client --> sdk

  subgraph consumer["Downstream consumer - Consumer (reference)"]
    bapi["apps/api<br/>thin createApp()"]
    bweb["apps/web (Next)<br/>mounts react-sdk pages"]
    bplug["@consumer/plugins<br/>one feature per folder"]
    bcfg["extensions.config.ts<br/>+ pnpm link: overrides"]
    bplug --> bcfg
    bcfg --> bapi
  end
  nest -. createApp + link .-> bapi
  sdk --> bweb
  shad --> bweb
  uiplug --> bweb

  subgraph ai["AI dev surface"]
    mcp["mcp-server-dev<br/>stdio, via .mcp.json"]
    scaffold["tools/scaffold.ts<br/>+ slash commands"]
    agentsmd["AGENTS.md<br/>(per package)"]
  end
  mcp -. inspects .-> orpc
  scaffold -. generates .-> mod
```

Solid arrows are runtime/build dependencies; dashed arrows are **adapter seams**
(one side declares an interface, the other implements it - swap freely).

## The parts

**Contracts**

- **shared-schemas** - shared Zod schemas (cross-cutting primitives + identity). Per-module request/response schemas live with the router in `orpc-contract`. Every type is `z.infer`'d, never hand-written. ADR-0004.
- **orpc-contract** - composes each module's router into one contract. From it the build emits `docs/openapi.json` and a fully typed client (no codegen step). ADR-0001.

**API runtime**

- **extensions.config.ts** - the one list of enabled plugins (modules + overlays). The only place wiring is turned on.
- **plugin-host** - `definePlugin({ id, dependsOn, register })` + `ModuleRegistry`. The bridge that mounts providers, controllers, routers, slots, events, imports, and MCP tools into the app. (The Drizzle migration removed the `prisma` extension surface; overlays add their own `pgTable` in their module's `src/schema/index.ts`.) ADR-0002.
- **NestJS + @orpc/nest** - owns DI, lifecycle, guards, request validation, and OpenAPI emission. `apps/api` is a thin caller of `createApp()` from `@oss/api-runtime`; downstream consumers call the same factory.

**Platform services** (`packages/platform/*`) - shared infrastructure modules may import: `db` (`@oss/db` - Drizzle client, drizzle-kit migrations, `DrizzleService`, the NestJS-free `@oss/db/orm` re-export, tenant-scoped helpers), `auth` (better-auth + the shared `AdminGuard`), `core` (logger, tenant context, typed `EventBus`), `plugin-host` (the plugin loader).

**Business modules** (`packages/modules/*`) - one folder per domain. A module may import contracts, platform, UI, and SDK packages, but **never another module** - cross-module communication goes through events or shared contracts. Each depends on vendor adapter interfaces from `@oss/adapters`.

**Vendor adapters** - concrete implementations of a module's adapter interfaces (PSP, KYC vendor, casino aggregator, chat), shipped as separate packages. The interface is the seam; the implementation is swappable.

**worker** (`apps/worker`) - consumes events emitted by modules (e.g. wallet deposit completed) and runs long-running jobs off the request path.

**Headless UI**

- **ui-provider-contract** - the component interface (`Button`, `Input`, `DataTable`, slots). Module UI imports only this. ADR-0003.
- **ui-provider-shadcn** - the default adapter implementing the contract. Swap it for your own (MUI, Chakra, ...) with no module changes.
- **react-sdk** - the admin surface: typed oRPC client, TanStack Query hooks, theme (`--bo-*` tokens), app shell, page bodies, and the UI plugin registry.
- **UI plugin registry** - client-side `defineUIPlugin({ register(ctx) })` lets a plugin add nav items, table columns, dashboard tiles, detail sections, and routes to the admin without forking the SDK. ADR-0006.

**Downstream consumer (Consumer, reference)** - does **not** fork. `apps/api` is a thin `createApp()` entry with its own `extensions.config.ts`; `@oss/*` packages resolve via `pnpm` `link:` overrides. `apps/web` (Next) mounts react-sdk page bodies in 4-line route shims and swaps the UI adapter at the layout. Consumer-specific features live in a single `@consumer/plugins` package, one folder per feature. ADR-0005.

**AI dev surface**

- **mcp-server-dev** - a stdio MCP server (registered in `.mcp.json`, not a port) exposing read-only inspection (`list-modules`, `list-routes`, `query-openapi`, `get-drizzle-schema`, ...) and write tools that delegate to the scaffolder.
- **tools/scaffold.ts** - deterministic code-mods behind the `/scaffold-*` slash commands (module, plugin, route, ui-component). Consumer adds `/scaffold-feature` for its plugins package.
- **AGENTS.md** - per-package brief; the first thing an agent reads.

## Adapter / bridge seams

These are the swap points - the reason the platform is "headless" and extensible:

| Seam          | Interface side                    | Implementation side                        | Swap to...                                       |
| ------------- | --------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Plugin host   | `definePlugin` contract           | a module or overlay folder                 | add/remove features without touching core        |
| Vendor adapter | `@oss/adapters` (interface)          | impl package under `modules/<m>/adapters/<vendor>/` | a different PSP, KYC, or aggregator   |
| UI provider   | `ui-provider-contract`            | `ui-provider-shadcn` (default)             | your own component library                       |
| UI plugin     | `defineUIPlugin` slots            | a plugin's `ui.tsx`                        | extend the admin without forking the SDK         |
| Consumer link | `createApp()` + `@oss/*` packages | downstream `apps/api` + `link:` overrides  | publish to npm and bump the tag (no code change) |

## Request flow (a typical read)

```mermaid
sequenceDiagram
  participant UI as react-sdk (admin)
  participant API as NestJS + @orpc/nest
  participant Mod as Module service
  participant DB as Drizzle (tenant-scoped)

  UI->>API: typed oRPC call (GET /players)
  API->>API: validate against Zod contract + guards
  API->>Mod: delegate to service
  Mod->>DB: withTenant query
  DB-->>Mod: rows
  Mod-->>API: domain objects (Zod-shaped)
  API-->>UI: typed response
```

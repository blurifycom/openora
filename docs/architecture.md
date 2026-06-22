# Architecture

How the platform fits together: the contract spine, the plugin host that loads
everything, the adapter seams that keep it swappable, and how a downstream
consumer reuses it without forking.

For the rationale behind each choice, see the [ADRs](./adr/). For the rules an
agent must follow, see [AGENTS.md](../AGENTS.md).

> **Packaging note (ADR-0025, 2026-06-16):** the foundation, engine, and free domains
> now ship as ONE published package, `@blurifycom/core`, with subpaths - `@blurifycom/core/contracts`
> (isomorphic), `@blurifycom/core/react` (browser), `@blurifycom/core/server` (node engine: kernel +
> plugin-host + db + auth + createApp), `@blurifycom/core/compliance`, and per-module subpaths.
> The logical structure described below is unchanged; specifier names like `@blurifycom/adapters`,
> `@blurifycom/db`, `@blurifycom/orpc-contract`, `@blurifycom/react` are now `@blurifycom/core/*` subpaths. Premium
> features stay separate `@blurifycom-addons/*` packages. See [ADR-0025](./adr/0025-single-core-package-with-module-subpaths.md).

## System overview

```mermaid
flowchart TB
  subgraph contracts["@blurifycom/core/contracts - the source of truth (isomorphic)"]
    zod["/contracts schemas<br/>single Zod root"]
    orpc["/contracts composeContract<br/>(health only; no aggregation)"]
    openapi["docs/openapi.json<br/>(emitted)"]
    client["typed client<br/>(zero codegen)"]
    zod --> orpc
    orpc --> openapi
    orpc --> client
  end

  subgraph runtime["API runtime - apps/api calls createApp()"]
    cfg["extensions.config.ts<br/>plugin registry"]
    host["plugin-host<br/>definePlugin / ModuleRegistry"]
    container["Container<br/>functional composition (tokens -> factories)"]
    hono["Hono + oRPC OpenAPIHandler<br/>validation, OpenAPI emit"]
    cfg --> host
    host --> container
    container --> hono
    orpc --> hono
  end

  subgraph platform["@blurifycom/core/server - node engine"]
    db["/server db<br/>Drizzle client + migrations"]
    auth["/server auth<br/>better-auth + AdminGuard"]
    core["/server kernel<br/>logger, EventBus, Container"]
  end

  subgraph modules["Domains (packages/domains/* - each deps @blurifycom/core)"]
    mod["pam (identity·profile·player-mgmt), compliance,<br/>wallet, casino (gaming·lobby·aggregator),<br/>sportsbook, engagement (chat·notifications·bonus·leaderboard), cms"]
    adapters["@blurifycom/core/contracts<br/>vendor adapter interfaces (ports)"]
    mod --> adapters
  end

  vendor["Vendor adapters<br/>PSP, KYC, aggregator, chat"]

  host --> mod
  container --> auth
  mod --> db
  mod --> core
  adapters -. implemented by .-> vendor

  subgraph consumer["Downstream consumer (reference)"]
    bapi["apps/api<br/>thin createApp()"]
    bfront["frontend (consumer repo)<br/>own pages, components, styling<br/>consumes api over HTTP via @blurifycom/core/react"]
    bplug["consumer plugins<br/>one feature per folder"]
    bcfg["extensions.config.ts<br/>+ pnpm link: overrides"]
    bplug --> bcfg
    bcfg --> bapi
  end
  hono -. createApp + link .-> bapi
  client --> bfront
  hooks --> bfront

  subgraph ai["AI dev surface"]
    mcp["mcp-server-dev<br/>stdio, via .mcp.json"]
    scaffold["tools/gen.ts<br/>+ slash commands"]
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
- **plugin-host** - `definePlugin({ id, dependsOn, register })` + `ModuleRegistry`. In `register(ctx)` a plugin binds providers (`ctx.provide(token, factory)`), mounts routers (`ctx.routers.add(namespace, (c) => router)`), subscribes to events, and registers MCP tools. Overlays add their own `pgTable` in their module's `src/schema/index.ts`. ADR-0002.
- **Hono + oRPC** - oRPC defines routes and validates I/O against the Zod contract; its `OpenAPIHandler` is mounted on a Hono server and emits `docs/openapi.json`. Dependency wiring is a small **functional composition `Container`** (`@blurifycom/core/server`): typed-token factories, lazy + last-wins, no decorators. `apps/api` is a thin caller of `createApp()` from `@blurifycom/core/server`; downstream consumers call the same factory. ADR-0009.

**Engine** (`@blurifycom/core/server`) - the node runtime, all under one subpath: `db` (Drizzle client, drizzle-kit migrations, `DrizzleService`, the framework-free `@blurifycom/core/server/orm` re-export), `auth` (better-auth + the shared `AdminGuard`), `kernel` (logger, typed `EventBus`, composition `Container`), `plugin-host` (the plugin loader), and `createApp()` - which is domain-agnostic (the consumer injects the PAM identity schema, ADR-0025/0026: single-tenant, no resolveTenant).

**Domains** (`packages/domains/*`) - one package per domain (`@blurifycom/<domain>`), each depending on `@blurifycom/core` only. A domain may import `@blurifycom/core/*` but **never another domain** - cross-domain communication goes through events, command ports, or shared contracts. Vendor adapter interfaces come from `@blurifycom/core/contracts`.

**Vendor adapters** - concrete implementations of a module's adapter interfaces (PSP, KYC vendor, igaming aggregator, chat), shipped as separate packages. The interface is the seam; the implementation is swappable.

**Background jobs** - long-running work runs off the request path in a BullMQ worker shipped as an overlay plugin (`/scaffold-plugin <name>-worker`): a module emits an event via the typed `EventBus`, the worker plugin subscribes in `register(ctx)` and processes the job. There is no standalone worker app.

**SDK & consumption surface**

- **`@blurifycom/core/react`** - the supported frontend consumption surface: data hooks, typed oRPC client, auth, and client-side realtime transport. The platform is headless backend only; the frontend lives in the downstream consumer repo.
- **`@blurifycom/core/compliance`** - canonical list of `SealedToken<T>` services operators may never override (RG enforcement, KYC writes, AML/SAR, ledger writes, RNG, etc.) with regulatory citations.

**Downstream consumer (reference)** - does **not** fork. `apps/api` is a thin `createApp()` entry with its own `extensions.config.ts`; `@blurifycom/*` packages resolve via `pnpm` workspace overrides (`link:`). The platform is headless: the frontend lives in the downstream consumer repo and consumes the api over HTTP via `@blurifycom/core/react`. Per-operator backend customization lives in plugins under `apps/api/src/extensions/`. ADR-0005 + ADR-0012 + ADR-0013.

**AI dev surface**

- **mcp-server-dev** - a stdio MCP server (registered in `.mcp.json`, not a port) exposing read-only inspection (`list-modules`, `list-routes`, `query-openapi`, `get-drizzle-schema`, ...) and write tools that delegate to the scaffolder.
- **tools/gen.ts** (-> `@blurifycom/turbo-generators`) - deterministic code-mods behind the `/scaffold-*` slash commands (module, plugin, route).
- **AGENTS.md** - per-package brief; the first thing an agent reads.

## Adapter / bridge seams

These are the swap points - the reason the platform is "headless" and extensible:

| Seam           | Interface side                           | Implementation side                                        | Swap to...                                       |
| -------------- | ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| Plugin host    | `definePlugin` contract                  | a module or overlay folder                                 | add/remove features without touching core        |
| Vendor adapter | `@blurifycom/core/contracts` (interface) | impl under `domains/<m>/adapters/<vendor>/` (or an add-on) | a different PSP, KYC, or aggregator              |
| Consumer link  | `createApp()` + `@blurifycom/*` packages | downstream `apps/api` + `link:` overrides                  | publish to npm and bump the tag (no code change) |

## Request flow (a typical read)

```mermaid
sequenceDiagram
  participant UI as consumer frontend (@blurifycom/core/react)
  participant API as Hono + oRPC
  participant Mod as Module service
  participant DB as Drizzle

  UI->>API: typed oRPC call (GET /players)
  API->>API: validate against Zod contract + AdminGuard.assert
  API->>Mod: delegate to service (built by the container)
  Mod->>DB: query
  DB-->>Mod: rows
  Mod-->>API: domain objects (Zod-shaped)
  API-->>UI: typed response
```

## Inter-module communication & scalability

The API layer is a backend-for-frontend: it triggers commands and serves reads.
Modules do **not** call each other - they couple to **topics**, not to each
other's routes. See [ADR-0010](./adr/0010-event-driven-broker-and-microservices.md)
for the full direction; the shape:

- **Events for side effects.** A module emits via the typed `EventBus` (payloads
  validated against the Zod catalog in `shared-schemas/events.ts`); any number of
  modules subscribe (fan-out) with `ctx.events.on(...)`, wired to the bus at boot
  by `createApp`. Bonuses, AML checks, leaderboards, notifications, and
  personalization react this way. Consumers must be idempotent (delivery is
  at-least-once once a durable broker is bound). A throwing subscriber is logged
  and isolated - it never breaks the emitter or its siblings.
- **Synchronous + atomic for money - via command ports.** Placing a bet (wallet
  debit, balance check, RGS result) and pre-action gates (KYC/jurisdiction) run
  inside a single `db.transaction(...)` - never "emit and hope". A module that must
  mutate another synchronously calls the owner's **command port** passing its own
  `tx` (eg sportsbook -> `WALLET_COMMANDS.debit(tx, ...)`): atomic in-process, yet
  decoupled enough to split later (a remote impl runs a saga). Events record what
  already happened; they never move funds.
- **Broker behind a seam.** The `EventBus` is a typed facade over a
  `MessageBrokerAdapter` (`MESSAGE_BROKER` token); the default binding is an
  in-process broker. Bind a durable driver - **Redpanda** (Kafka API) for the
  regulated audit/ledger/replay stream, NATS JetStream for lighter fan-out - in an
  overlay to swap the transport without touching module code.
- **Durable events via the outbox.** When an event must survive a crash or a
  process boundary, a service emits it inside its transaction with
  `events.emitInTransaction(tx, ...)`: the envelope is written to `event_outbox`
  atomically with the state change, and the `OutboxRelay` publishes it after commit
  (at-least-once; consumers dedup on `eventId`). Opt-in via `OUTBOX_ENABLED` / a
  durable broker; off in the in-process monolith.
- **Client push is separate.** WebSockets/SSE are client-facing only (chat,
  balance/bonus toasts), never the transport between modules.
- **Modular monolith now, microservices later.** The no-cross-module-imports rule,
  the broker seam, and the outbox make a hot module (eg `bonus`, `aggregator`)
  extractable into its own deployable. The same codebase boots a subset via
  `SERVICE_MANIFEST` (`pnpm create:service` scaffolds a thin host); point its broker
  at the shared stream and its events keep flowing. The `no-cross-module-schema-read`
  lint warning flags the remaining shared-table couplings to retire first. Scale the
  stateless Hono API horizontally; scale async work by moving consumers to their own
  services. See [ADR-0017](./adr/0017-extraction-readiness-manifest-outbox-command-ports.md).

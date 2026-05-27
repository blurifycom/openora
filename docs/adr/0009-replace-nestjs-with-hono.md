# ADR-0009: Replace NestJS with Hono + a functional composition container

**Date**: 2026-05-27
**Status**: Accepted (supersedes [ADR-0001](./0001-orpc-and-nestjs-for-api.md))

## Context

ADR-0001 chose oRPC on top of NestJS, primarily for Nest's DI container and module system (used by the plugin host). In practice that coupling cost more than it bought us:

- **Decorators + reflective DI are LLM-unfriendly.** `@Injectable`/`@Inject(TOKEN)` and `emitDecoratorMetadata` hide the wiring an agent has to reason about. This platform is AI-native; explicit wiring an agent can read top-to-bottom matters more than container ergonomics.
- **Express-bound, no Bun.** Nest runs on Express (or Fastify) and cannot run on Bun. We want the option to move the runtime to Bun for performance later, behind a Docker image, without a framework rewrite.
- **Weight.** Nest pulls a large dependency tree for features we do not use (we have no Nest guards/interceptors; auth is context-based; only one lifecycle hook existed).
- oRPC already ships a first-class fetch/Hono adapter, so the route layer ports with no contract changes.

## Decision

Replace NestJS with **Hono** (served on Node via `@hono/node-server`; Bun-ready later) and replace Nest DI with a **small functional composition container** (`Container` in `@oss/core`).

- **Routing:** oRPC stays. Routes are built contract-first with `implement(contract).$context<OssContext>()` and mounted via oRPC's `OpenAPIHandler` (`@orpc/openapi/fetch`) as Hono middleware. The SDK keeps using `OpenAPILink`, so REST paths and the emitted OpenAPI spec are unchanged. `OpenAPIGenerator` still emits `docs/openapi.json`.
- **Composition over DI:** a `Token<T>` is a typed `Symbol` (in `@oss/adapters`); a provider is an explicit factory `(c) => new Service(c.get(DEP), ...)`. Resolution is lazy, cached, and last-registration-wins (so an overlay rebinds an adapter by registering after the owning module). No decorators, no `reflect-metadata`.
- **Plugin host:** `definePlugin({ register(ctx) })` now exposes `ctx.provide(token, factory)` and `ctx.routers.add(namespace, (c) => router)` (plus `events`, `slots`, `mcp`). The Nest `DynamicModule`/controller path is gone.
- **Services are plain classes.** Constructors take explicit dependencies; the module's `plugin.ts` builds them via the container. Cookies/response headers (auth) flow through oRPC's `ResponseHeadersPlugin` (`context.resHeaders`) instead of an Express `Response`.
- **Lifecycle:** `DrizzleService.dispose()` (pool teardown) is registered with `container.onDispose()` and run on server close / SIGTERM.

## Consequences

**Positive:**

- Every wiring point is an explicit, greppable function call - matches pillar 5 ("explicit > magic") and is far easier for agents to follow and edit.
- Smaller, faster surface; Hono is edge/Bun-native, so a future runtime swap is a Docker concern, not a code rewrite.
- oRPC, Zod-first contracts, and the OpenAPI surface are unchanged; the SDK and consumers are unaffected beyond a dependency bump.

**Negative / trade-offs:**

- We own a tiny container instead of leaning on a mature framework. It is ~60 lines and intentionally minimal (no scopes/request-DI); that is acceptable because the app composes a fixed graph at boot.
- Optional adapters (eg geo-IP, aggregator) are resolved with `c.has(TOKEN) ? c.get(TOKEN) : null` rather than Nest's `@Optional()`.

**Neutral:**

- Runtime stays Node for now (`@hono/node-server`); moving to Bun is a follow-up.

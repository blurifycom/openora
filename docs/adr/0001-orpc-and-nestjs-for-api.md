# ADR-0001: oRPC + NestJS for the API layer

**Date**: 2026-05-18
**Status**: Accepted

## Context

We need end-to-end TypeScript type inference from the server to every client (backoffice, Consumer frontend, third-party builders) without locking non-TS consumers out. We also need a robust DI container and lifecycle management for the plugin system. Candidates evaluated:

- tRPC + NestJS - type inference is great but clients must use the tRPC client; breaks non-TS or non-JS consumers.
- ts-rest + NestJS - contract-first with a separate contract object; good, but slightly more boilerplate and less active maintenance vs oRPC.
- oRPC + Hono - lighter, more transparent, but loses NestJS's module system which we rely on for plugin loading.
- oRPC + NestJS via `@orpc/nest` - keeps Nest DI, gains type inference, emits OpenAPI automatically.
- Plain NestJS + OpenAPI codegen - standard, zero inference drift risk, but requires a codegen step for TS clients and codegen can lag.

## Decision

Use **oRPC** (`@orpc/nest`) on top of **NestJS**. oRPC handles route registration, input/output validation via Zod, and automatic OpenAPI spec emission. NestJS handles DI, guards, interceptors, lifecycle hooks, and the module system used by the plugin host.

## Consequences

**Positive:**

- TS clients get full inference via `@orpc/react-query` and the oRPC client - no codegen step.
- OpenAPI spec is auto-emitted from the same Zod schemas: non-TS consumers use `@hey-api/openapi-ts` or plain `fetch`.
- NestJS module system stays intact, which is how the plugin host loads/unloads feature modules at boot.
- oRPC supports modern types (Date, BigInt, File, async iterators for SSE) out of the box.

**Negative / trade-offs:**

- Two frameworks in one app (`@orpc/nest` acts as the glue). Slightly more to learn than pure Nest or pure oRPC.
- oRPC is less mature than NestJS itself; breaking changes possible. Mitigation: the oRPC surface is isolated to route definitions; swapping it out later would not affect services or domain logic.

**Neutral:**

- tRPC and ts-rest can be revisited if oRPC's OpenAPI support proves insufficient. The Zod schemas stay the same regardless.

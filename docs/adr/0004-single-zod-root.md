# ADR-0004: Single Zod root for all contracts

**Date**: 2026-05-18
**Status**: Accepted

## Context

Type drift between modules, client SDK, and OpenAPI spec is a common source of bugs. The temptation is to define types in multiple places and "keep them in sync". We need a pattern that makes drift structurally impossible.

## Decision

All shared schemas live in `packages/contracts/domain-schemas/`. Types are always `z.infer<typeof Schema>` - never hand-written interfaces that shadow Zod schemas. Module-local schemas live in `packages/modules/<name>/src/schemas/` but re-export from `domain-schemas` wherever types are shared.

The oRPC router uses `.input(Schema).output(Schema)`. The same schemas feed the OpenAPI generator and the client SDK. One source, many derived consumers.

A lint rule bans ad-hoc Zod schema definitions outside `schemas/` or `domain-schemas`.

## Consequences

**Positive:**

- Rename a field in `domain-schemas` and every consumer (route, SDK, OpenAPI, client) fails to compile until updated. Drift is a compile error, not a runtime bug.
- AI agents can read `domain-schemas` to understand the data model without tracing through controllers.
- OpenAPI spec is guaranteed to match the runtime validation.

**Negative / trade-offs:**

- `domain-schemas` can become large. Mitigation: namespace by domain (`identity.ts`, `wallet.ts`). Import only what you need.
- Module-local schemas that graduate to cross-module use must be moved to `domain-schemas`. This is a mechanical refactor but requires touching multiple files.

**Neutral:**

- Zod v4 is the current version. Zod v3 schemas from older platform packages will need upgrading before they can participate in the shared root.

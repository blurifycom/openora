# ADR-0035: Serve OpenAPI from the running API

**Date**: 2026-08-04
**Status**: Proposed
**Supersedes**: the static OpenAPI artifact decisions in ADR-0001 and ADR-0009, and the edition-aware static artifact assumption in ADR-0021.

## Context

The generated `docs/openapi.json` was a build-time snapshot of a composed contract. It
could become stale when a consumer changed its enabled plugins or contract composition,
and it required a separate generator and drift check to stay aligned with the API that
was actually serving requests.

`createApp()` already has the final router after plugins have registered. oRPC's
`OpenAPIReferencePlugin` can expose both an API reference and its OpenAPI document from
that router, so a checked-in copy has no separate value.

## Decision

Serve the API reference from `createApp()` at `/docs` and the matching OpenAPI document
at `/openapi.json`. Both are derived from the router that the running application serves.

Remove the static `docs/openapi.json` generation path and references to it. The catalog
remains a generated repository artifact for the MCP development surface; it is not an
API specification replacement.

This ADR supersedes the static OpenAPI artifact portions of ADR-0001 and ADR-0009 and
the edition-aware static artifact assumption in ADR-0021. Those ADRs remain unchanged
as historical records.

## Consequences

**Positive:**

- The published document matches the runtime router, including the consumer's enabled
  plugins and composed contract.
- Consumers have no OpenAPI generation step to run or static API artifact to commit.

**Negative / trade-offs:**

- The reference is available only while an API instance is running; a release does not
  include a checked-in OpenAPI snapshot.
- Consumers that need a versioned snapshot must retrieve `/openapi.json` from the
  deployed API as part of their own release process.

## References

- `packages/core/src/server/runtime/create-app.ts` - runtime reference registration.
- ADR-0001 - original oRPC and OpenAPI decision.
- ADR-0009 - Hono runtime migration.
- ADR-0021 - contract composition and edition behavior.

# ADR-0019: Session-based caller authentication (drop the trusted `x-user-id` header)

**Date**: 2026-06-09
**Status**: Accepted; implemented.
**Relates to**: ADR-0018 (RLS tenant isolation - this closes its W1 trust boundary), ADR-0009 (oRPC + Hono + functional container).

## Context

The platform identified the request's caller from a raw `x-user-id` HTTP header
(`getUserId` in `@oss/core`), and likewise the tenant from `x-tenant-id`
(`getTenantId`). Nothing verified those headers, so any client could set
`x-user-id: <someone-else>` and act as that user - and because ADR-0018 resolves the
RLS tenant from the caller, a forged `x-user-id` for a user in another tenant also
switched tenants. RLS was defense-in-depth against a forgotten `WHERE` clause, but it
inherited this forged-identity hole (ADR-0018 W1). Real clients already authenticate
with a better-auth session cookie (the SDK sends `credentials: 'include'`), and the
admin path already verified that cookie via `AdminGuard.assert()`; the raw header was a
server-side shortcut / test seam, not a production requirement.

## Decision

**1. One shared verified-session resolver.** `SessionResolver` (`@oss/auth`,
`session-resolver.ts`) wraps a single better-auth `Auth` instance and exposes
`resolveUserId(headers): Promise<string | undefined>` - it calls
`auth.api.getSession({ headers })` and returns the verified `session.user.id`, or
`undefined` when there is no valid session (it never throws on a missing session, since
public routes legitimately have none). It is bound under the `AUTH_SESSION` token in
`createApp`, where the better-auth schema (user/session/account/...) is already
injected. `AdminGuard` now consumes this shared resolver instead of building its own
`createAuth`, so there is exactly one better-auth init over the DB.

**2. Resolve the session once per request.** The `createApp` Hono middleware verifies
the session cookie on the incoming headers via `AUTH_SESSION`. On a valid session it
gets the verified `userId`, maps it to its `tenantId` (server-side, on the BYPASSRLS
`adminDb` - `resolveTenantForUser`), publishes the verified identity onto the oRPC
context (`context.auth = { userId, tenantId }`), and runs the handler inside
`withTenant(...)` + `runWithTenant(tenantId, ...)` exactly as before. With no valid
session (or no resolvable tenant) `context.auth` stays undefined and no GUC is set, so
the RLS app role sees zero rows - fail-closed.

**3. `getUserId`/`getTenantId` read the verified context, not headers.** Both now read
`context.auth.{userId,tenantId}` (a new optional `AuthContext` field on `OssContext`)
and throw `ORPCError('UNAUTHORIZED')` when absent. `@oss/core` cannot import `@oss/auth`
(it would create a cycle and pull better-auth into the leaf platform package), so the
verification happens in the api-runtime middleware and core only reads the field the
middleware populated. The `x-user-id` / `x-tenant-id` trust paths are removed entirely -
a forged header reaches no auth/tenant decision.

**4. Tests use real sessions.** The `asPlayer` test helper now logs in with a seeded
player's real credentials (`/identity/login`) and carries the session cookie, mirroring
`asAdmin` - it no longer injects `x-user-id`. Seeded players have deterministic creds
(`player.<n>@demo.igaming.dev` / `password123`) and the demo `tenantId`, so a logged-in
player sees only its own tenant's data under RLS. A regression test asserts a forged
`x-user-id` with no session cookie is rejected with 401.

## Consequences

- A forged `x-user-id` no longer authenticates anyone or switches tenants; auth and RLS
  tenant scoping both derive from the verified better-auth session. ADR-0018 W1 is
  closed.
- One better-auth instance backs both the per-request middleware and `AdminGuard` (no
  duplicate `createAuth`).
- Player routes require a real session cookie. The SDK already sends one; the in-tree
  `x-user-id` shortcut is gone, including from tests (which now log in).
- `@oss/core` stays free of an `@oss/auth` dependency - the verified identity is passed
  through the oRPC context, not resolved inside core.

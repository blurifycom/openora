# ADR-0018: Row-Level Security tenant isolation

**Date**: 2026-06-09
**Status**: Accepted; implemented (RLS migration + leak-safe per-request GUC binding + two-role connection paths + server-side tenant resolution).
**Relates to**: ADR-0010 (event-driven broker / multitenancy + extraction direction), the `tenantId`-on-every-multi-tenant-table convention (AGENTS.md), ADR-0016/0017 (outbox + system paths).

## Context

Every multi-tenant table carries a `tenantId` column, but nothing enforced it. Tenant
scoping relied on each service remembering to add `WHERE tenantId = ...` - a single
missed filter is a cross-tenant data leak, the worst failure mode for an igaming
operator hosting multiple brands. The `TenantContext` primitive (`@oss/core`,
AsyncLocalStorage) existed but was unused per-request, and an unsafe `setTenantId`
helper did a session-level `SET app.tenant_id` on a pooled connection - which leaks
the tenant scope onto whatever request next borrows that connection.

We want defense in depth: even a service that forgets its `WHERE` clause must not be
able to read or write another tenant's rows. Postgres Row-Level Security (RLS) moves
the guarantee into the database.

## Decision

**1. RLS policy on every tenant-scoped table.** A hand-authored migration
(`0006_rls_tenant_isolation.sql` - drizzle-kit does not emit policies) runs, for each
of the 17 tenant tables, `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `FOR ALL` policy:

```sql
USING ("tenantId" = current_setting('app.tenant_id', true))
WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))
```

The column is the existing quoted-camelCase `"tenantId"` (not snake_case). The `true`
(missing_ok) form of `current_setting` returns NULL when the GUC is unset, so a
connection with no tenant set sees ZERO rows - **fail-closed**, never an error.
`event_outbox` (nullable tenantId, system-written) additionally allows `tenantId IS NULL`.

**2. Two connection paths / two roles.**
- `oss_app` - a plain role (NOT superuser, NOT BYPASSRLS) for per-request traffic.
  RLS applies to it. `DATABASE_URL` points here in production.
- `oss_system` - a `BYPASSRLS` role for system paths that legitimately cross tenants:
  the outbox relay, `seed`, migrations, and any sanctioned cross-tenant admin query.
  `DATABASE_ADMIN_URL` points here (falls back to `DATABASE_URL` in single-role setups).

`DrizzleService` opens both pools and exposes `db` (tenant-aware app path) and
`adminDb` (BYPASSRLS system path). The migration creates both roles idempotently
(guarded `DO` blocks) so it is reproducible on a fresh cluster.

**Superuser caveat (must read).** A Postgres superuser - and any BYPASSRLS role -
ALWAYS bypasses RLS, even with `FORCE`. The common local/CI setup runs a single
superuser owner, so the app path there transparently bypasses RLS (existing tests are
unaffected). To actually exercise RLS, connect as `oss_app`. The migration gives
`oss_app` LOGIN + a dev-only password (`oss_app_dev`) so the integration test and
local dev can connect as a genuinely enforced role on a fresh single-superuser cluster;
operators MUST rotate that password before any non-local deployment. `FORCE` is still
set so the policy applies to the table owner when the owner is non-superuser.

**3. Leak-safe per-request GUC binding.** The pool hands out arbitrary connections and
the `DrizzleService.db` singleton is shared across concurrent requests, so a
session-level `SET` cannot safely pin a tenant. Instead `runWithTenant(tenantId, fn)`
(`tenant-connection.ts`):

1. checks out ONE dedicated client from the app pool,
2. `SELECT set_config('app.tenant_id', $1, false)` on it (parameterized),
3. publishes a drizzle bound to that single client through an AsyncLocalStorage and
   runs `fn` inside it,
4. in a `finally`: resets the GUC (`set_config('app.tenant_id', '', false)`) and
   releases the client; if the reset throws (broken connection) it destroys the client
   (`release(true)`) so a dirty connection never re-enters the pool.

`DrizzleService.db` is a Proxy that, on every access, routes to the request-pinned
client when one exists (via `getRequestDb()`) and to the pool-backed app db otherwise.
Existing singleton services calling `this.drizzle.db` transparently get the
tenant-scoped connection - no service signature changed.

**4. Server-side tenant resolution.** `tenantId` is resolved from the authenticated
user, never trusted from a client header. The `user` table gained a `tenantId` column
(the seam). `create-app.ts`'s Hono middleware reads `x-user-id`, looks up the user's
`tenantId` on the BYPASSRLS `adminDb` (the `user` table is not RLS-scoped - auth must
resolve a user before a tenant is known), then runs the whole request inside both
`withTenant(...)` (for event correlation) and `runWithTenant(...)` (the pinned RLS
connection). Unauthenticated requests run with no GUC and are fail-closed on scoped
tables; public/auth routes only touch non-scoped tables on the admin path.

## Why the binding cannot leak

The tenant GUC lives on exactly ONE client that is checked out for the duration of one
request and never shared. It is cleared in a `finally` that runs whether `fn` resolves
or throws, BEFORE the client is released back to the pool. If the clearing query itself
fails, the client is destroyed instead of returned, so a connection that might still
carry `app.tenant_id` can never be reused. Concurrent requests each get their own
checked-out client and their own AsyncLocalStorage frame, so they cannot observe each
other's GUC. Therefore a connection returned to the pool never carries a residual tenant
scope. The unsafe session-level `setTenantId` was removed.

**5. Every tenant-scoped insert stamps the request tenant.** The `WITH CHECK` half of
the policy rejects any insert whose `tenantId` is not the active GUC. Services that
create a row in a scoped table set its `tenantId` from the request tenant - either
derived from a parent row already read under the same GUC (eg a wallet transaction
takes its wallet's tenantId), or read directly via `getCurrentTenantId()` (`@oss/core`,
the ALS accessor that mirrors `getCurrentTenant()` and returns the same value
`runWithTenant` pinned as the GUC). The earlier placeholders (`tenantId: ''`,
`'default'`, or an omitted column) are rejected by `WITH CHECK` on the enforced role,
so they were fixed to the request tenant.

## Trusted boundaries and operational requirements

- **Migrations need owner/superuser (not `oss_app`).** 0006/0007 run `CREATE ROLE`,
  `ALTER DEFAULT PRIVILEGES`, `ENABLE`/`FORCE ROW LEVEL SECURITY`, and `CREATE POLICY` -
  privileged DDL the RLS-enforced `oss_app` role cannot execute. Run `drizzle-kit
  migrate` under `DATABASE_ADMIN_URL` (the owner / `oss_system` role); `drizzle.config.ts`
  prefers `DATABASE_ADMIN_URL` and falls back to `DATABASE_URL` for single-role local/CI.
  Pointing migrate at `oss_app` fails.
- **Boot-time role guard (W2).** `DrizzleService` probes the app pool's role on
  construction (`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname =
  current_user`) and logs a loud warning if it is a superuser or BYPASSRLS - because RLS
  is then inert for per-request traffic. It does not hard-fail (local/CI run a single
  superuser legitimately); production must point `DATABASE_URL` at `oss_app`.
- **Trusted boundary - the `x-user-id` header (W1, out of scope here).** RLS resolves
  the tenant from the authenticated user, but the platform's current auth model trusts
  the `x-user-id` request header to identify that user (see `getUserId`). RLS therefore
  inherits that trust boundary: a caller that can forge `x-user-id` for a user in another
  tenant resolves that tenant. Hardening the auth model (signed sessions only, drop the
  raw header) is a separate decision, not part of this ADR. RLS is defense-in-depth
  against a *forgotten WHERE clause*, not against a forged identity.
- **Background workers and the ALS frame (W3).** RLS scoping rides the AsyncLocalStorage
  frame `create-app` opens per request. Code that runs OUTSIDE a request (job-queue
  workers, the outbox relay, scheduled tasks) has no tenant GUC and so the app role sees
  zero rows (fail-closed). A per-tenant worker MUST wrap its work in
  `runWithTenant(envelope.tenantId, () => ...)`; legitimately cross-tenant system code
  uses `adminDb` (BYPASSRLS). See `@oss/db` AGENTS.md.
- **Outbox / GUC agreement (W4).** The EventBus lifts the envelope `tenantId` from the
  same tenant ALS that `create-app` uses to set the GUC, so a transactional-outbox write
  (`emitInTransaction`) can never stamp a `tenantId` that differs from the active GUC -
  and the `event_outbox` policy additionally allows `tenantId IS NULL` for system events.

## Consequences

- A missed `WHERE tenantId = ...` in a service is no longer a cross-tenant leak on the
  enforced app role - the database filters it. Defense in depth, not a replacement for
  correct queries.
- An insert that omits or hard-codes a wrong `tenantId` now FAILS at runtime on the
  enforced role (`WITH CHECK`), turning a silent leak into a loud error. Services stamp
  the request tenant via `getCurrentTenantId()` or a parent row.
- System code that must cross tenants resolves `adminDb` explicitly. Backoffice/admin
  request traffic is scoped to the admin's own tenant by default (more secure);
  genuine cross-tenant platform reads opt into `adminDb`.
- Production requires provisioning `oss_app` / `oss_system` (the migration creates them)
  and pointing `DATABASE_URL` at the non-superuser `oss_app`. Local/CI on a superuser
  owner runs with RLS transparently bypassed unless connected as `oss_app`.
- Per-request connection check-out adds one acquire + two `set_config` round-trips per
  request. Acceptable; the connection is pinned for the whole request anyway.

## Implementation status

- Migration: `packages/platform/db/drizzle/migrations/0006_rls_tenant_isolation.sql`
  (+ journal entry, + chained snapshot). 17 tables, two roles.
- Migration `0007_slimy_wrecking_crew.sql`: adds the missing `tenantId` column to
  `user_limit` (responsible-gaming / AML) and `notification` (PII) - which shipped
  scoped-by-userId-only and so unprotected - and hand-authors the same ENABLE + FORCE +
  policy for both (guarded `CREATE POLICY` so it is idempotent).
- App-layer reconciliation: tenant-scoped inserts stamp the request tenant
  (`getCurrentTenantId()` in wallet / compliance / notifications / gaming /
  player-management / chat / aggregator; parent-row tenant in bonus / sportsbook /
  leaderboard / chat-room). Added `getCurrentTenantId()` to `@oss/core`.
- Seed: `seedDemoData` stamps `DEMO_TENANT_ID` (`'default'`) on every scoped row AND on
  the seeded `user.tenantId`, so login resolves the demo tenant and the player sees the
  seeded data under RLS.
- Guards: boot-time role probe in `DrizzleService` (W2); a `@oss/db` unit test
  (`rls-policy-coverage.test.ts`, I3) enumerates every `pgTable` with a `tenantId` column
  and asserts a matching ENABLE+FORCE+policy in the migrations SQL (the `user` table is an
  explicit, documented exemption). `drizzle.config.ts` migrate URL prefers
  `DATABASE_ADMIN_URL` (I2).
- Binding: `packages/platform/db/src/tenant-connection.ts`,
  `DrizzleService` (`drizzle.service.ts`) two pools + `db` proxy + `runWithTenant`.
- Removed unsafe `setTenantId` (`drizzle.ts`).
- Wiring: `create-app.ts` middleware + `tenant-resolver.ts`; `user.tenantId` column.
- System paths: outbox relay uses `adminDb`; seed (`tools/seed.ts`, `@oss/testing`)
  uses the admin/BYPASSRLS path.
- Tests: unit `tenant-connection.test.ts` (leak/reset/isolation), integration
  `apps/api/test/integration/rls-tenant-isolation.integration.test.ts` (cross-tenant
  read/write/delete blocked, fail-closed, admin sees all - run as `oss_app`).

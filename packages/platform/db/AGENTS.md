# @oss/db - agent brief

Drizzle client + migrations + the RLS tenant-isolation seam. Platform layer: may
import other `platform/*` and `@oss/contracts/*`; never modules or UI.

## What lives here

| File                   | Purpose                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle.service.ts`   | `DrizzleService` + `DRIZZLE` token. Two pg pools (app/RLS + admin/BYPASSRLS), the tenant-aware `db` proxy, `adminDb`, `runWithTenant`. |
| `tenant-connection.ts` | `runWithTenantConnection` + `getRequestDb` - the leak-safe per-request GUC binding (AsyncLocalStorage).                                |
| `drizzle.ts`           | `createDrizzleDb` (raw pool, for CLIs/seed). The unsafe `setTenantId` was REMOVED (ADR-0018).                                          |
| `query-helpers.ts`     | `findOneOrThrow`, `pageToOffset`.                                                                                                      |
| `outbox/`              | transactional outbox writer + relay (ADR-0016/0017).                                                                                   |
| `orm.ts`               | the NestJS-free drizzle surface (`@oss/db/orm`) - tables + operators for cross-workspace consumers.                                    |
| `drizzle/migrations/`  | drizzle-kit migrations. Hand-authored RLS migration is `0006`.                                                                         |

## RLS tenant isolation (ADR-0018) - read before touching tenant data

- Every table with a `tenantId` column is RLS-enforced: a policy restricts rows to
  `"tenantId" = current_setting('app.tenant_id', true)`. A missed `WHERE` is no longer
  a cross-tenant leak on the app role - but write correct queries anyway.
- **App path (default):** services call `this.drizzle.db` as before. In a request the
  `db` proxy routes to a connection pinned to the caller's tenant (set by
  `create-app.ts` via `runWithTenant`). The tenant is resolved server-side from the
  authenticated user (`user.tenantId`), never a client header.
- **System path (cross-tenant):** resolve `drizzle.adminDb` (BYPASSRLS role). Use it
  ONLY for legitimately cross-tenant work: the outbox relay, seed, migrations,
  sanctioned platform-wide admin reads. It never sets `app.tenant_id`.
- **Never** do a bare session `SET app.tenant_id` on a pooled connection - it leaks to
  the next request. For a transaction-local scope use `SET LOCAL` INSIDE `db.transaction`.
- **Stamp tenantId on every scoped insert.** The policy's `WITH CHECK` rejects an insert
  whose `tenantId` is not the active GUC, so an omitted / hard-coded value fails at
  runtime on the `oss_app` role. Set it from the request tenant: `getCurrentTenantId()`
  (`@oss/core`, the ALS accessor that returns the same value `runWithTenant` pinned), or
  from a parent row already read under the same GUC. Never insert `''` / a literal tenant.
- **Adding a new tenant table?** Add `tenantId: text('tenantId').notNull()`, run
  `pnpm regen`, then ADD it to the RLS migration pattern in a NEW hand-authored
  migration (copy a block from `0006`/`0007`). drizzle-kit will not do this for you. The
  `rls-policy-coverage` unit test FAILS until you do - it enumerates every `pgTable` with
  a `tenantId` column and asserts a matching ENABLE+FORCE+policy (this is the I3 guard
  that would have caught the `user_limit`/`notification` leak). A table that is
  intentionally not scoped (like `user`, read before a tenant is known) goes in that
  test's `RLS_EXEMPT` set with a reason.
- **Migrations run under owner/superuser, NOT `oss_app`.** 0006/0007 do `CREATE ROLE`,
  `ALTER DEFAULT PRIVILEGES`, `FORCE RLS`, `CREATE POLICY` - privileged DDL `oss_app`
  cannot run. `drizzle-kit migrate` reads `DATABASE_ADMIN_URL` first (falls back to
  `DATABASE_URL` for single-role dev/CI). Pointing migrate at `oss_app` fails.
- **Background workers / system code escape the request ALS frame (W3).** RLS scoping
  lives on the AsyncLocalStorage frame `create-app` opens per request. A job-queue worker,
  the outbox relay, or a scheduled task runs with NO tenant GUC - the app role then sees
  zero rows (fail-closed). A per-tenant worker MUST wrap its work in
  `runWithTenant(envelope.tenantId, () => ...)`; legitimately cross-tenant system code
  uses `adminDb` (BYPASSRLS). The outbox relay already uses `adminDb`.

## Roles / config

- `DATABASE_URL` -> `oss_app` (RLS-enforced) in production. `DATABASE_ADMIN_URL` ->
  `oss_system` (BYPASSRLS); falls back to `DATABASE_URL` in single-role dev/CI.
- Superusers/BYPASSRLS roles bypass RLS even with FORCE. Local/CI on a superuser owner
  runs RLS transparently bypassed; connect as `oss_app` (dev password `oss_app_dev`,
  rotate in prod) to actually exercise it - that is what the integration test does.

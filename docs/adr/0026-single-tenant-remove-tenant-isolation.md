# ADR-0026: Single-tenant platform - remove tenant isolation

**Date**: 2026-06-18
**Status**: Accepted; implementing.
**Supersedes**: ADR-0018 (RLS tenant isolation).
**Amends**: ADR-0016 (drop `tenantId` from the event envelope), ADR-0010 (multitenancy direction).
**Relates to**: ADR-0017 (outbox/system paths), ADR-0019 (session auth), ADR-0024/0025 (packaging).

## Context

The platform shipped multi-tenant: a `tenantId` column on every domain table, per-tenant
unique indexes, Postgres Row-Level Security (ADR-0018: 17 tables, `oss_app`/`oss_system`
roles, a per-request GUC-pinned connection), server-side tenant resolution
(`tenant-resolver.ts`), and a `tenantId` field on the event envelope (ADR-0016).

That model targets a **provider/aggregator** hosting many operators' brands in one database.
That is not what this platform is. Per the mission, the OSS platform is **deployed by an
operator for its own brand** - one clone, one deployment, one database, one brand. There is
no second tenant to isolate from. The multi-tenant machinery is therefore pure cost:

- **Complexity / cognition.** Two DB roles, a per-request connection check-out + two
  `set_config` round-trips, a `db` Proxy, an AsyncLocalStorage tenant frame, a fail-closed
  GUC, and a "stamp the request tenant on every insert" rule every service must remember.
- **Operational burden.** Provisioning `oss_app`/`oss_system`, rotating the dev password,
  pointing `DATABASE_URL` at the non-superuser role, hand-authored RLS migrations
  drizzle-kit cannot emit.
- **A foot-gun, not a guard, in a single-tenant world.** RLS fail-closes to zero rows when
  the GUC is unset (background workers, mis-wired requests), turning "single-tenant" into
  "mysteriously empty" bugs - guarding against a cross-tenant leak that cannot happen.

YAGNI: we are not building a multi-tenant aggregator, so we remove the isolation built for one.

## Decision

Make the platform **single-tenant** and delete the tenant-isolation subsystem end to end.

1. **Drop `tenantId` everywhere.** Remove the column from every `pgTable`; rebuild the unique
   indexes that included it to their natural keys (`(tenantId, key)` -> `(key)`,
   `(tenantId, userId, roleId)` -> `(userId, roleId)`, `(tenantId, roleId, resource)` ->
   `(roleId, resource)`, etc.). Remove `tenantId` from inserts and `WHERE` clauses in every
   service, and from `contracts/schemas/common.ts`, `events.ts`, and the broker/job-queue/
   wallet-commands/audit adapter payloads.

2. **Remove RLS (supersede ADR-0018).** Delete the RLS policies, `ENABLE`/`FORCE`, the
   `oss_app`/`oss_system` roles, `tools/gen-rls.ts`, the RLS coverage test, and the
   boot-time role probe. The deployment uses a single DB role again.

3. **Remove the tenant runtime.** Delete `server/runtime/tenant-resolver.ts`,
   `server/db/tenant-connection.ts`, `server/kernel/tenant-context.ts`, the `db` Proxy /
   `runWithTenant` / `getCurrentTenantId` / `withTenant` machinery, and the dual
   `db`/`adminDb` split in `DrizzleService` (one pool, one `db`).

4. **Breaking API change to `createApp`.** `createApp` no longer accepts or calls
   `resolveTenant`. This is a breaking change for consumers (consumer's `apps/api` injects it
   today) and requires a new `@oss/core` major + a coordinated consumer update.

5. **Drop the envelope `tenantId` (amend ADR-0016).** `EventEnvelope` loses `tenantId`;
   `orderingKey`/`traceId` stay. Outbox/relay no longer carry or filter by tenant.

6. **One migration.** `pnpm regen` plus a hand-authored step to `DROP COLUMN "tenantId"`,
   drop/rebuild the affected unique indexes, drop the RLS policies, and drop the roles -
   idempotent, applied via the normal migrate path (now single-role).

## Consequences

- **Simpler everything:** one DB role, one connection path, no GUC round-trips, no
  per-insert tenant stamping, no fail-closed-empty class of bugs. Services are plain
  `WHERE`-by-business-key again.
- **No multi-brand/skin support out of the box.** An operator that later needs multiple
  brands on one deployment must reintroduce a discriminator - a deliberate future ADR, not
  a default carried by everyone. (A second brand can also just be a second deployment.)
- **Breaking release.** `@oss/core` majors; the consumer template and consumer `apps/api`
  drop the `resolveTenant` wiring. Downstream must bump in lockstep.
- **Auth/RLS defense-in-depth is gone** - acceptable because there is no second tenant to
  leak to; correctness of business `WHERE` clauses is unchanged (they were never the
  cross-tenant guard anyway, RLS was).
- **History:** old migrations that added `tenantId`/RLS stay in the journal; the new
  migration removes them forward. A fresh DB ends in the single-tenant shape.
- **Cut-over, not incremental.** Migration history is reset to fresh `0000` baselines, so
  there is NO incremental upgrade path from a multi-tenant DB - a deployment with the old
  schema must recreate the DB (drop + re-migrate + re-seed). Acceptable: no production
  consumer is live on the multi-tenant schema.
- **Audit advisory lock is now global.** The append-only hash-chain lock dropped its
  per-tenant key (`pg_advisory_xact_lock(hashtext('audit_log'))`), so all audit appends
  serialize on one lock. Correct and fine for a single-tenant operator; revisit only if
  audit write throughput ever becomes a bottleneck.

## Implementation plan

| Phase | Scope                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | This ADR.                                                                                                                                              |
| 2     | Schemas: drop the column + rebuild indexes across casino/pam/compliance/engagement/iam/audit/sportsbook/cms/outbox.                                    |
| 3     | Runtime/kernel: delete tenant-resolver / tenant-connection / tenant-context; collapse `DrizzleService` to one pool; `createApp` drops `resolveTenant`. |
| 4     | RLS: delete `gen-rls.ts`, policies, roles, coverage test, role probe.                                                                                  |
| 5     | Services/contracts: strip `tenantId` from queries/inserts/payloads + envelope.                                                                         |
| 6     | `pnpm regen` -> the drop migration; `pnpm seed` no longer stamps tenant.                                                                               |
| 7     | Tests updated; rules/docs (`overview`, `clean-architecture`, `architecture.md`, glossary) drop the tenant convention.                                  |
| 8     | Cross-repo: `@oss/core` major publish; consumer `apps/api` + consumer template drop `resolveTenant`.                                                    |

## Implementation status

Implemented (2026-06-18). `tenantId`/RLS removed across ~120 files; fresh single-tenant
migration baselines generated; `pnpm verify` green; `pnpm regen` clean. `gaming.endRound`
gained an explicit caller-ownership filter (RLS was previously its only guard). Cross-repo:
consumer `apps/api` dropped `resolveTenant` (separate change).

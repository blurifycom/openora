# Audit Module

Append-only, tamper-evident audit log. A regulatory requirement under MGA/UKGC:
operators must retain an immutable 5-year record of player financial transactions,
admin actions, game results, login/logout events, and config/permission changes.

## What this module does

Owns the `audit_log` table. Each row is hash-chained to the previous row (per
tenant) via SHA-256, making the log tamper-evident: any modified or deleted row
breaks the chain at that point, detectable by `verifyChain()`. The module exposes
two admin routes (`audit.list`, `audit.exportCsv`), subscribes to platform domain
events to record them automatically, and binds the `AUDIT_WRITER` port so other
modules can record entries explicitly without importing this module's internals.

## Layout

| Layer   | File                       | Holds                                                         |
| ------- | -------------------------- | ------------------------------------------------------------- |
| schema  | `schema/index.ts`          | `audit_log` pgTable + `actorTypeEnum`. Append-only by design. |
| schemas | `schemas/index.ts`         | Re-exports from `@oss/orpc-contract/audit`; inferred types.   |
| service | `service/audit.service.ts` | `record`, `list`, `exportCsv`, `verifyChain`.                 |
| router  | `router/index.ts`          | `audit.list` (audit:view), `audit.exportCsv` (audit:export).  |
| plugin  | `plugin.ts`                | DI wiring, AUDIT_WRITER port, event subscriptions.            |

Contract slice: `packages/contracts/orpc-contract/src/audit.ts`.

## Sealed token decision

The brief requested a `createSealedToken` for the audit write port, reflecting
that AML/SAR audit writes are a regulator-mandated invariant operators must not
override (MGA/UKGC).

**Finding:** the plugin host's `ctx.provide(token, factory)` signature is typed
`<T>(token: Token<T>, ...)`. `SealedToken<T>` is structurally incompatible (the
`__sealed: true` brand makes it a different type), so the TypeScript compiler
rejects `ctx.provide(sealedToken, ...)` at the call site. The runtime guard in
`ModuleRegistryImpl.provide` also throws for any token whose Symbol description
starts with `sealed:`. Neither escape hatch exists - a module cannot bind its own
sealed token through the public API.

**Decision:** `AUDIT_WRITER` uses a regular `Token<T>` (via `createToken`). The
invariant is enforced by design (no update/delete routes or service methods) and
documented here. A future platform version could add a `bindSealedToken` hook on
`ModuleRegistry` that bypasses the overlay-rejection guard for the owning module
only. See `packages/contracts/adapters/src/audit.ts` for the full rationale comment.

## Hash chain approach

Each `record()` call:

1. Reads the latest row's `hash` for the tenant (or null for the first row).
2. Inserts the row with `prevHash` = that value and a placeholder `hash = 'pending'`.
3. Computes `sha256(JSON.stringify({ id, tenantId, actorId, actorType, action, resourceType, resourceId, seq, createdAt, prevHash: prevHash ?? '' }))` - stable key order.
4. Updates the row with the real hash.

`verifyChain(tenantId)` re-derives every hash from scratch and reports the first
broken link. Used for tamper detection and as a test target.

`list` and `exportCsv` both apply an explicit `eq(tenantId, getCurrentTenantId())`
predicate (resolved per call) as defense-in-depth alongside RLS. `exportCsv` is
capped at `AuditService.EXPORT_MAX_ROWS` (50_000) so it cannot be used for
unbounded bulk extraction / OOM - narrow the date range and paginate for larger
windows, or use `verifyChain` for full-chain integrity.

## Extension points

### Ports

| Interface        | Token          | File                       | Purpose                                   |
| ---------------- | -------------- | -------------------------- | ----------------------------------------- |
| `AuditWritePort` | `AUDIT_WRITER` | `@oss/adapters` `audit.ts` | Write path other modules call explicitly. |

### Events subscribed (existing `domainEventSchemas` topics only)

`identity.user.registered`, `identity.user.login`, `identity.2fa.enabled`,
`identity.2fa.disabled`, `identity.password.reset`, `identity.email.verified`,
`identity.profile.updated`, `wallet.deposit.completed`,
`wallet.withdrawal.completed`, `gaming.round.started`, `gaming.round.ended`,
`bonus.claimed`, `compliance.limit.upserted`, `compliance.limit.removed`,
`cms.page.published`, `iam.invitation.accepted`.

Mapping: if the payload has a `userId` field the row uses `actorType='player'`;
otherwise `actorType='system'`. The event topic becomes the `action` column value.

### oRPC routes

| Procedure         | Method | Path            | Guard          |
| ----------------- | ------ | --------------- | -------------- |
| `audit.list`      | GET    | `/audit/logs`   | `audit:view`   |
| `audit.exportCsv` | GET    | `/audit/export` | `audit:export` |

No create/update/delete routes. Writes happen only via `record()` (called by the
event subscribers in `plugin.ts` or by callers of the `AUDIT_WRITER` port).

## Do

- Use `AUDIT_WRITER` from `@oss/adapters` to record entries from other modules/overlays.
- Call `verifyChain(tenantId)` in a scheduled job or admin tool to detect tampering.
- Add new event subscriptions in `plugin.ts` only for topics declared in
  `domainEventSchemas` - never invent topics.
- For regulator export, stream `exportCsv` to a file; `csv` field in the response
  is plain text suitable for direct download.

## Don't

- Expose update or delete on `audit_log` - it is append-only by regulatory requirement.
- Import another module's root or internals - use events / `AUDIT_WRITER` / the `/schema` subpath.
- Invent event topics not in `domainEventSchemas`.
- Hand-edit the generated migrations under `packages/platform/db/drizzle/`.

## Done when

- [x] `pnpm verify` exits 0.
- [x] `audit_log` table in Drizzle schema with all required columns.
- [x] Migration 0010 generated; RLS migration 0011 generated.
- [x] `AUDIT_WRITER` token declared in `@oss/adapters`.
- [x] `audit.list` and `audit.exportCsv` routes guarded with `audit:view` / `audit:export`.
- [x] `verifyChain` helper implemented and tested.
- [x] 12 unit tests covering: record() hash chaining, verifyChain() tamper detection, list() pagination, exportCsv() format.
- [x] Sealed token decision documented (regular Token used; reason above).
- [x] No boundary violations (`pnpm boundaries` clean).

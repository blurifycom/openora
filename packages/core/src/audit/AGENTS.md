# Audit Module

Append-only, tamper-evident audit log. A regulatory requirement under MGA/UKGC:
operators must retain an immutable 5-year record of player financial transactions,
admin actions, game results, login/logout events, and config/permission changes.

## What this module does

Owns the `audit_log` table. Each row is hash-chained to the previous row via SHA-256,
making the log tamper-evident: any modified or deleted row breaks the chain at that point,
detectable by `verifyChain()`. The module exposes two admin routes (`audit.list`,
`audit.exportCsv`), subscribes to platform domain events to record them automatically,
and binds the `AUDIT_WRITER` port so other modules can record entries explicitly
without importing this module's internals.

## Layout

| Layer    | File                       | Holds                                                                          |
| -------- | -------------------------- | ------------------------------------------------------------------------------ |
| schema   | `schema/index.ts`          | `audit_log` pgTable + `actorTypeEnum`. Append-only by design.                  |
| contract | `contract/index.ts`        | oRPC contract slice + Zod schemas; exported as `@openora/core/audit/contract`. |
| service  | `service/audit.service.ts` | `record`, `list`, `exportCsv`, `verifyChain`.                                  |
| router   | `router/index.ts`          | `audit.list` (audit:view), `audit.exportCsv` (audit:export).                   |
| plugin   | `plugin.ts`                | DI wiring, AUDIT_WRITER port, event subscriptions.                             |

## Sealed token

`AUDIT_WRITER` is a real `SealedToken<AuditWritePort>` (AML/SAR audit writes are
a regulator-mandated invariant operators must not override - MGA/UKGC). This
module binds it via `ctx.provideSealed()` in `plugin.ts` - the only legitimate
bind path for a sealed token: `ctx.provide()` still rejects any sealed token
outright, and `provideSealed()` itself refuses a second bind for the same
token, so no overlay can rebind `AUDIT_WRITER` after this module registers it.
See `@openora/core/contracts` `adapters/token.ts` for the `provideSealed`
rationale and `@openora/core/compliance` `sealed.ts` for the canonical list.

## Hash chain approach

Each `record()` call:

1. Reads the latest row's `hash` (or null for the first row).
2. Inserts the row with `prevHash` = that value and a placeholder `hash = 'pending'`.
3. Computes `sha256(JSON.stringify({ id, actorId, actorType, action, resourceType, resourceId, before, after, result, seq, createdAt, prevHash: prevHash ?? '' }))` - stable key order, no tenantId (single-tenant). `before`/`after`/`result` are IN the hash: the mutation payload and outcome must be tamper-evident, not just the who/what/where.
4. Updates the row with the real hash.

`verifyChain()` re-derives every hash from scratch and reports the first broken link.
Used for tamper detection and as a test target.

`list` and `exportCsv` have no tenant filtering (single-tenant). `exportCsv` is capped
at `AuditService.EXPORT_MAX_ROWS` (50_000) so it cannot be used for unbounded bulk
extraction / OOM - narrow the date range and paginate for larger windows, or use
`verifyChain` for full-chain integrity.

## Extension points

### Ports

| Interface        | Token          | File                                 | Purpose                                   |
| ---------------- | -------------- | ------------------------------------ | ----------------------------------------- |
| `AuditWritePort` | `AUDIT_WRITER` | `@openora/core/contracts` `audit.ts` | Write path other modules call explicitly. |

### Events subscribed (existing `domainEventSchemas` topics only)

`identity.user.registered`, `identity.user.login`, `identity.2fa.enabled`,
`identity.2fa.disabled`, `identity.password.reset`, `identity.email.verified`,
`identity.profile.updated`, `wallet.deposit.completed`,
`wallet.withdrawal.completed`, `gaming.round.started`, `gaming.round.ended`,
`bonus.claimed`, `compliance.limit.upserted`, `compliance.limit.removed`,
`compliance.kyc.updated`, `compliance.kyc.submitted`,
`compliance.kyc.reverify_required`, `compliance.geo-rule.added`,
`rg.limit.set`, `rg.cooling_off.activated`, `rg.self_exclusion.activated`,
`rg.self_exclusion.lifted`, `rg.exclusion.login_blocked`,
`cms.page.published`, `iam.invitation.accepted`.

The RG activity log / change history reuses this module: `list`/`exportCsv` take an
optional `actionPrefix` filter (`like(action, 'rg.%')`); the four admin RG events map
to `actorType='admin'`, `resourceType='player'`, `resourceId=userId`, and
`rg.exclusion.login_blocked` maps to a system `result='failure'` entry.

Mapping: `wallet.*` events record `actorType='player'`, `actorId=userId`,
`resourceType='transaction'`, `resourceId=transactionId` (so a transaction
reference is searchable, not buried in `after`). Otherwise, if the payload has a
`userId` field the row uses `actorType='player'`; failing that, `actorType='system'`.
The event topic becomes the `action` column value.

### oRPC routes

| Procedure         | Method | Path            | Guard          |
| ----------------- | ------ | --------------- | -------------- |
| `audit.list`      | GET    | `/audit/logs`   | `audit:view`   |
| `audit.exportCsv` | GET    | `/audit/export` | `audit:export` |

No create/update/delete routes. Writes happen only via `record()` (called by the
event subscribers in `plugin.ts` or by callers of the `AUDIT_WRITER` port).

`audit.list` / `audit.exportCsv` accept optional filters `actorId`, `actorType`,
`action`, `resourceType`, `resourceId`, `fromDate`, `toDate`, plus a single search
param `q` that exact-matches `actorId` OR `resourceId` (covers player ID, admin
identity, and transaction reference). Filters combine with AND; `q` is the grouped
OR within that AND. Exact-match only - keeps the `actorId`/`resourceId` indexes usable.

## Do

- Use `AUDIT_WRITER` from `@openora/core/contracts` to record entries from other modules/overlays.
- Call `verifyChain()` in a scheduled job or admin tool to detect tampering.
- Add new event subscriptions in `plugin.ts` only for topics declared in
  `domainEventSchemas` - never invent topics.
- For regulator export, stream `exportCsv` to a file; `csv` field in the response
  is plain text suitable for direct download.

## Don't

- Expose update or delete on `audit_log` - it is append-only by regulatory requirement.
- Import another module's root or internals - use events / `AUDIT_WRITER` / the `/schema` subpath.
- Invent event topics not in `domainEventSchemas`.
- Hand-edit the generated migrations under the module's `drizzle/migrations/` - the source of truth is `src/schema/index.ts`.

## Done when

- [x] `pnpm verify` exits 0.
- [x] `audit_log` table in Drizzle schema with all required columns.
- [x] `audit_log` migration generated in the module's `drizzle/migrations/` (single-tenant, no RLS).
- [x] `AUDIT_WRITER` token declared in `@openora/core/contracts`.
- [x] `audit.list` and `audit.exportCsv` routes guarded with `audit:view` / `audit:export`.
- [x] `verifyChain` helper implemented and tested.
- [x] 12 unit tests covering: record() hash chaining, verifyChain() tamper detection, list() pagination, exportCsv() format.
- [x] Sealed token decision documented (regular Token used; reason above).
- [x] No boundary violations (`pnpm boundaries` clean).

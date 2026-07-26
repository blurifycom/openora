# audit

Append-only, tamper-evident audit log - a regulatory requirement (MGA/UKGC: immutable 5-year record of financial transactions, admin actions, game results, logins, config/permission changes). Owns `audit_log`, exposes admin-guarded `audit.list`/`audit.exportCsv`, auto-records subscribed domain events, and binds the `AUDIT_WRITER` port for explicit writes. Subscribed topics: `SUBSCRIBED_TOPICS` in `plugin.ts` - only topics declared in `domainEventSchemas`, never invented ones.

## Sealed token

`AUDIT_WRITER` is a `SealedToken<AuditWritePort>` - AML/SAR audit writes are a regulator-mandated invariant operators must not override. This module binds it via `ctx.provideSealed()` in `plugin.ts`, the only legitimate bind path: `ctx.provide()` rejects sealed tokens outright and `provideSealed()` refuses a second bind, so no overlay can rebind it. Rationale: `@openora/core/contracts` `adapters/token.ts`; canonical sealed list: `@openora/core/compliance` `sealed.ts`.

## Hash chain

Each `record()` runs in a single transaction serialized by a pg advisory lock:

1. Read the latest row's `hash` (null for the first row) as `prevHash`.
2. Compute `sha256(JSON.stringify(...))` over the full row INCLUDING `before`/`after`/`result` - the mutation payload and outcome must be tamper-evident, not just who/what/where - with stable top-level key order.
3. Insert `prevHash` + the real `hash` in ONE statement - no read-back UPDATE, so a crash can never leave a placeholder hash.

Gotcha: `before`/`after` are `jsonb` and Postgres reorders nested object keys on read-back (length-then-lex), so `computeHash` deep-sorts those keys (arrays keep order) before stringifying - otherwise a freshly-inserted row and the same row read back would hash differently despite identical content. `verifyChain()` re-derives every hash from rows read back from Postgres and reports the first broken link; run it from a scheduled job or admin tool for tamper detection.

## Query semantics

`list`/`exportCsv` filters combine with AND; the single search param `q` is a grouped OR that EXACT-matches `actorId` OR `resourceId` - exact only, to keep those indexes usable. `exportCsv` is capped at `EXPORT_MAX_ROWS` (50k) so it cannot be used for unbounded bulk extraction / OOM - narrow the date range for larger windows. The RG activity log / change history reuses this module via the `actionPrefix` filter (`like(action, 'rg.%')`) - no separate history table.

## Event -> row mapping

`wallet.*` events record `actorType='player'`, `resourceType='transaction'`, `resourceId=transactionId` (a transaction reference is searchable, not buried in `after`). Otherwise a payload with `userId` maps to `actorType='player'`; failing that, `system`. The topic becomes the `action` column. The four admin RG events map to `actorType='admin'`, `resourceType='player'`, `resourceId=userId`; `rg.exclusion.login_blocked` maps to a system `result='failure'` entry.

## Don't

- Expose update or delete on `audit_log` - append-only by regulatory requirement. Writes happen only via `record()` (event subscribers or `AUDIT_WRITER` callers).
- Invent event topics not in `domainEventSchemas`.

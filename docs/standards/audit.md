# Audit

Read this before adding a state-changing action or changing audit storage, events, or exports.

- Every mutation that changes player, operator, money, KYC, permissions, or configuration state must produce an audit record with actor, resource, outcome, and meaningful before/after state. Use a declared domain event after commit, or write through `AUDIT_WRITER`; money-path records join the business transaction.
- Every topic in `domainEventSchemas` is either in the audit plugin's `SUBSCRIBED_TOPICS` or classified (audited at source, or exempt with a reason) in `audit/contract/coverage.ts`; `tsc` fails on a new topic that is neither. Write at source when the record must commit with the change it describes. A topic written at source either stays out of `SUBSCRIBED_TOPICS`, or stays in it and its event payload carries `auditRecorded: true`, which the subscriber skips, so the record is never written twice.
- A safety net, not a substitute: an admin-guarded non-GET route (not a `view` grant) that returns without an audit write or a published topic in `AUDIT_WRITER.auditedTopics` gets one `admin.<resource>.<action>` row holding the route and the input's key names and hash (never the values), and any handler error other than a 401/403 gets a failure row (`server/runtime/admin-mutation-audit.ts`). It has no before/after and a failed write is only logged (fail open), so a route that changes state still audits that state itself.
- `AUDIT_WRITER` is sealed. Only the audit module binds it; overlays and domains must not replace it.
- Every agent tool call and action execution through the MCP kernel that names a valid actor leaves exactly one audit record, a read included, carrying hashes of the input and output rather than the data; a precondition check is not audited. A call whose record cannot be written fails instead of returning data, so never reach an agent tool or action type around the kernel. The kernel's record says that a call happened; an action executor still audits the state it changed, like any other mutation (ADR-0042).
- Audit rows are append-only, enforced by `ENABLE ALWAYS` database triggers that deny UPDATE, DELETE and TRUNCATE on `audit_log` and `audit_outbox_rejected` to every role, the owner included. `audit_outbox` denies UPDATE and TRUNCATE and allows a DELETE only of a row already in `audit_log` or `audit_outbox_rejected`. Never add update or delete behavior, and never invent a topic outside `domainEventSchemas`.
- A write through `AUDIT_WRITER` queues the record in `audit_outbox` inside the caller's transaction and takes no lock; the audit shipper appends it to the chain after commit, so `audit_log` lags the write by up to a poll. Never read `audit_log` back to decide what the write just did (a marker belongs in a business table); a test drains the outbox first (`flushAudit` in `@openora/testing`). `recordAuditInTransaction` is deprecated (use `enqueueAuditInTransaction`; removed in the next minor release) and still appends directly, taking the chain lock until its commit ([ADR-0052](../adr/0052-audit-outbox-shipper.md)).
- `seq` is the authoritative order of the trail, assigned when the shipper appends. `created_at` is the time the record was queued in the business transaction, the business time of the change rather than its commit time, so it can run out of `seq` order. Order by `seq`, never by `created_at`.
- The chain's unique indexes use `NULLS NOT DISTINCT`, so the minimum Postgres version is 15.
- Bets and wins are not copied into the audit log: `wallet_transaction` and `game_round` are the game-play and financial records, and database triggers keep them append-only (no delete; only status and settlement columns change, and a row in a final status stays final, a round's totals never shrink; a reversed stake leaves `bet_amount` only by landing in `reversed_amount`). Voids and large single bets or wins above the configured threshold are the significant events that are audited.
- Preserve the hash-chain protocol: serialize concurrent appends (the shipper's chain lock, backed by unique `seq`, `event_id` and `prev_hash`), include the full persisted record in the hash, and use a stable deep key order for JSON values. Insert the final hash with the row, never as a later update.
- A denial audit signal must come from a real backend request; a client-side route guard's redirect never reaches the server, so it is never a substitute. Every authorization denial emits the same event regardless of where it is thrown - a service-level check that denies before ever reaching a shared guard (e.g. `AdminGuard.assert()`) still needs its own explicit emit, not just the guard's.

## Runbook

**Forked chain.** Two rows sharing a `prev_hash` mean the chain forked, which the unique `prev_hash`
index should make impossible. Detect it with:

```sql
SELECT prev_hash, count(*) FROM audit_log GROUP BY prev_hash HAVING count(*) > 1 LIMIT 5;
```

Export the affected rows and their neighbours by `seq` as evidence before touching anything. Repair
only under a change ticket: disabling the append-only trigger is itself an audited change, so record
who disabled it, when and why in the ticket and the trail, re-enable it `ENABLE ALWAYS` in the same
session, and notify the regulator where the licence requires it.

**Growing outbox or rejected rows.** `auditOutboxBacklog(db)` returns the pending count, the age of the
oldest pending row and the rejected count. A pending age that keeps growing means no shipper holds
the lock or every round fails: check the `audit-shipper` error logs and for a session holding
`pg_advisory_xact_lock(hashtext('audit_shipper'))`. A rejected row failed the entry schema and never
reached the chain; its `error` column says why. Fix the mapping that produced it, and record the
missing change from `entry` through `AUDIT_WRITER` under a change ticket. Rejected rows are never
deleted.

# Audit

Read this before adding a state-changing action or changing audit storage, events, or exports.

- Every mutation that changes player, operator, money, KYC, permissions, or configuration state must produce an audit record with actor, resource, outcome, and meaningful before/after state. Use a declared domain event after commit, or write through `AUDIT_WRITER`; money-path records join the business transaction.
- Every topic in `domainEventSchemas` is either in the audit plugin's `SUBSCRIBED_TOPICS` or classified (audited at source, or exempt with a reason) in `audit/contract/coverage.ts`; `tsc` fails on a new topic that is neither. Write at source when the record must commit with the change it describes. A topic written at source either stays out of `SUBSCRIBED_TOPICS`, or stays in it and its event payload carries `auditRecorded: true`, which the subscriber skips, so the record is never written twice.
- A safety net, not a substitute: an admin-guarded non-GET route (not a `view` grant) that returns without an audit write or a published topic in `AUDIT_WRITER.auditedTopics` gets one `admin.<resource>.<action>` row holding the route and the input's key names and hash (never the values), and any handler error other than a 401/403 gets a failure row (`server/runtime/admin-mutation-audit.ts`). It has no before/after and a failed write is only logged (fail open), so a route that changes state still audits that state itself.
- `AUDIT_WRITER` is sealed. Only the audit module binds it; overlays and domains must not replace it.
- Every agent tool call and action execution through the MCP kernel that names a valid actor leaves exactly one audit record, a read included, carrying hashes of the input and output rather than the data; a precondition check is not audited. A call whose record cannot be written fails instead of returning data, so never reach an agent tool or action type around the kernel. The kernel's record says that a call happened; an action executor still audits the state it changed, like any other mutation (ADR-0042).
- Audit rows are append-only, enforced by `ENABLE ALWAYS` database triggers that deny UPDATE, DELETE and TRUNCATE on `audit_log` and `audit_outbox_rejected` to every role, in replica mode too. `audit_outbox` denies UPDATE and TRUNCATE and allows a DELETE only of a row whose content is kept: the same entry in `audit_outbox_rejected` under its outbox id, or chained in `audit_log` under its event id with equal fields. Triggers do not stop DDL, so the table owner can still `ALTER TABLE ... DISABLE TRIGGER`; run the app as a role that does not own the audit tables, and migrations as the owner. Never add update or delete behavior, and never invent a topic outside `domainEventSchemas`.
- A write through `AUDIT_WRITER` queues the record in `audit_outbox` inside the caller's transaction and takes no lock; the audit shipper appends it to the chain after commit, so `audit_log` lags the write by up to a poll. Never read `audit_log` back to decide what the write just did (a marker belongs in a business table); a test drains the outbox first (`flushAudit` in `@openora/testing`). `recordAuditInTransaction` is deprecated (use `enqueueAuditInTransaction`; removed in the next minor release) and still appends directly, taking the chain lock until its commit ([ADR-0053](../adr/0053-audit-outbox-shipper.md)).
- The chain can live in a database of its own. Run the audit `migrate({ adminUrl, auditUrl, shipperUrl })` with `auditUrl` set to `AUDIT_DATABASE_URL` and `shipperUrl` to `AUDIT_SHIPPER_DATABASE_URL`, under the audit migration lock on the main database, so concurrent migrates take turns. It creates the audit database when missing and two login roles: the writer, from `auditUrl`, that may only connect to the audit database, read `audit_log` and append to it, and the shipper, from `shipperUrl` on the main database, the only role that may delete from `audit_outbox` and insert into `audit_outbox_rejected`; a migrate revokes those two grants from any other role that holds them. Each role is made with no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS and has a connection limit of 20; the migrate refuses a url role that already holds one of those attributes, is a member of another role, is the main admin or app role, or is the other audit role. The password is set from the url as a SCRAM verifier on every run, so a rotation is a migrate away; the verifier, not the password, reaches the server log under `log_statement = ddl`. The first split run revokes CONNECT on the main database from PUBLIC and grants it by name to every role that owns or holds a grant on one of its public tables; every run revokes it from the writer and grants it to the shipper. A role made later that only connects (monitoring, backup) needs its own `GRANT CONNECT`. Once split, the single-database migrate of that main database refuses to run.
- Set `AUDIT_DATABASE_URL` and `AUDIT_SHIPPER_DATABASE_URL` on every process that loads the audit plugin; the boot fails on the first without the second. The shipper appends as the writer and deletes the batch from the outbox as the shipper once the append has committed, so a crash in between ships the batch again and the append skips the event ids it holds. It refuses to ship into an empty audit database while the main one still holds `audit_log` rows: those legacy rows stay where they are until the audit-copy runbook moves them, and the shipper waits for it. `AUDIT_DATABASE_POOL_MAX` (default 3) sizes each of the two audit pools per process; keep replicas x `AUDIT_DATABASE_POOL_MAX` at or under 20, each role's connection limit. Other modules read the chain through `AUDIT_READER`, never the audit schema.
- `list`, `exportCsv` and `verifyChain` read the chain only, so they are eventually consistent: a record shows once shipped. `listMyRgHistory` also reads the player's pending outbox rows, so a player sees a limit change straight away. `verifyChain({ fromSeq, fromHash })` resumes from the last row an earlier run found intact, and fails at that row when it is gone or no longer hashes to `fromHash`. A job that stores the anchor also checks that the head `seq` it reads never falls below the one it stored: a chain cut back to before the anchor fails the anchored verify, but one cut back and regrown past it only shows there. `listMyRgHistory` gives a record its event id, queued or chained, so its id holds across the ship.
- `seq` is the authoritative order of the trail, assigned when the shipper appends. `created_at` is the time the record was queued in the business transaction, the business time of the change rather than its commit time (an event's `occurredAt` for a record mapped from one), so it can run out of `seq` order. Order by `seq`, never by `created_at`.
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
oldest pending row and the rejected count. Nothing polls it for you: wire it into alerting and page
when the rejected count is above zero or the oldest pending age passes a few seconds. A pending age
that keeps growing means no shipper holds the lock or every round fails: check the `audit-shipper`
error logs and for the session holding the shipper lock:

```sql
SELECT * FROM pg_locks WHERE locktype = 'advisory' AND objid = hashtext('audit_shipper')::oid;
```

A rejected row never reached the chain; its `error` column says why. A schema error means a mapping
produced a bad entry: fix it, and record the missing change from `entry` through `AUDIT_WRITER` under
a change ticket. `event_id already chained with different content` means an `audit_log` row under
that event id does not match the entry: treat it as possible tampering, compare the two, and keep
both as evidence. Rejected rows are never deleted.

**A shipper stuck on one row.** Every round fails on the same outbox row and the oldest pending age
keeps growing. A rejected row under that `outbox_id` with other content, next to an `audit_log` row
under its `event_id` with other content, means both were planted to launder the entry: the guard
keeps it pending on purpose. Export the outbox row, the rejected row and the chain row as evidence,
then resolve it under a change ticket as for a forked chain.

**Known gap.** The app role can still divert a pending entry by copying it into
`audit_outbox_rejected` under its own outbox id and deleting it: the content is kept but never
chained, and only the rejected count shows it, which is why a rejected count above zero pages. A
separate shipper database role, the only one that may insert into the rejected table and delete
from the outbox, closes it ([ADR-0053](../adr/0053-audit-outbox-shipper.md)). With the chain in a
database of its own that role exists: the main database cannot compare a deleted row with the
chain, so its guard lets a delete through only from a session that is a member of the shipper role
and holds the shipper lock, and only the shipper role holds the grants to delete or reject. The gap
stays open in the single-database mode.

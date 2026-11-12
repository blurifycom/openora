# ADR-0053: Audit outbox and shipper

**Date**: 2026-11-12
**Status**: Accepted
**Relates to**: [ADR-0016](./0016-event-envelope-and-transport-agnostic-broker.md) (event envelope and broker), [ADR-0045](./0045-at-least-once-event-delivery.md) (always-on outbox, dedup), [ADR-0042](./0042-mcp-kernel-two-registries-behind-one-enforcing-wrapper.md) (the kernel's audit record per agent call).

## Context

`audit_log` is a hash chain: each row hashes the one before it. Every writer appended inside its own
business transaction, so every writer took the chain lock and held it until its commit. On a busy
money path that serialized unrelated transactions on one lock, and a slow commit stalled every other
audited write behind it.

The event path already solved the same shape. ADR-0045 writes events to an outbox in the business
transaction and relays them after commit, with an id that dedups redelivery. The audit trail needs the
same guarantee, a record exists if and only if its change committed, without the shared lock.

## Decision

**A writer queues, a shipper chains.** `AUDIT_WRITER` and `enqueueAuditInTransaction` insert one row
into `audit_outbox` inside the caller's transaction and take no lock. The row carries the record and
a uuid `event_id`, unique in both `audit_outbox` and `audit_log`, so queueing the same record twice,
before or after it ships, leaves one row. An event the audit plugin subscribes to that is emitted in a
transaction is queued by `EventBus.tapTransactional`, in that transaction, from the envelope's event
id; the broker consumer path dedups against it. A consumer envelope id that is not a uuid is mapped to
a deterministic sha1 based uuid, so its redelivery still dedups.

**The shipper.** One loop per process per database (started by the audit plugin, stopped on container
dispose) takes `pg_try_advisory_xact_lock(hashtext('audit_shipper'))`, reads up to 1000 rows in id order,
appends them to the chain and deletes them, all in one transaction. A replica that does not get the
lock skips the round, so several replicas never fork the chain. It polls every 200ms when idle,
drains while there is work, and backs off exponentially, up to 5s, on error.

**A row the chain cannot take as it is moves aside, not retried.** A row that fails the entry schema,
or whose `event_id` the chain already holds with different content, goes to `audit_outbox_rejected`
with the reason (`event_id already chained with different content` for the second), copied
unchanged in SQL, is logged at error level with its id, and the rest of the batch ships. One bad row
never stops the trail, and a forged or colliding `audit_log` row never makes the shipper drop the real
entry as a duplicate. `audit_outbox_rejected` keeps one row per outbox row (unique `outbox_id`), so
two different entries under one `event_id` are both kept.

**Order and time.** `seq` is assigned at ship time and is the authoritative order of the trail.
`created_at` is the time the record was queued, inside the business transaction: it is the business
time of the change, not its commit time, so two rows can carry `created_at` out of `seq` order. A
record mapped from an event takes the event's `occurredAt`, so the tap and the consumer queue equal
entries for one event and the redelivery is chained once. Only those two event paths pass that
time, through `enqueueEventAuditInTransaction`, which `@openora/core/audit/server` does not export.
A record written through `AUDIT_WRITER` or `enqueueAuditInTransaction(txn, input)` is stamped when
it is queued under a fresh event id, whatever keys it carries, so a caller cannot backdate it. An entry dated year 0, which Postgres cannot store, fails the entry
schema and moves aside.

**Guards.** `ENABLE ALWAYS` triggers deny UPDATE and TRUNCATE on `audit_outbox` and allow a DELETE only
of a row whose content is kept elsewhere: a row in `audit_outbox_rejected` with the same `outbox_id`
and an equal `entry`, or the `audit_log` row with its `event_id` and every field the shipper copies
equal (actor, action, resource, before, after, ip, user agent, correlation id, result, created_at).
An id match alone is not enough, since the app role could insert a forged row under that id and then
delete the real one. `audit_outbox_rejected` is append-only like `audit_log`.

The triggers stop DML from every role, under `session_replication_role = replica` too. They do not
stop DDL: the table owner can still `ALTER TABLE ... DISABLE TRIGGER` and then change rows.
Production must run the app as a role that does not own the audit tables, and run migrations as the
owner. Every guard function pins `search_path = pg_catalog, public`, so a role cannot put its own
table or operator in front of the ones the guards read.

## Consequences

- `audit_log` lags the business write by up to a poll, longer under backlog. Nothing may read
  `audit_log` back to decide what a write just did; tests call `flushAudit`. `auditOutboxBacklog`
  reports the pending count, the age of the oldest pending row and the rejected count. There is no
  health check that reads it: operators must poll it into alerting and page on any rejected row or
  on an oldest pending age above a few seconds.
- `AUDIT_WRITER` no longer returns the appended row: the row does not exist yet when the write
  returns.
- `recordAuditInTransaction` still appends directly and still takes the chain lock. It is deprecated
  in favour of `enqueueAuditInTransaction` and removed in the next minor release.
- A shipper runs in every process that loads the audit plugin. The advisory lock keeps them from
  racing; the cost is one idle query per replica per poll.
- The chain still lives in the business database. Moving it to a database of its own is a follow-up:
  the shipper is the only writer, so it is the only code that has to change.
- `audit_log_seq_key` (unique) replaces the plain `seq` index.
- Known gap: the app role can still divert a pending entry by writing its exact copy into
  `audit_outbox_rejected` under its outbox id and then deleting it. The content is kept, but it is
  never chained, and only the rejected count of `auditOutboxBacklog` shows it. The fix is a separate
  shipper database role that alone may INSERT into `audit_outbox_rejected` and DELETE from
  `audit_outbox`, planned with moving the chain to a database of its own.
- A rejected row planted under a real `outbox_id` with other content, plus a forged chain row under
  its `event_id`, stalls the shipper on that row: the rejected insert is skipped and the delete
  guard refuses. That fails safe and loud, an error log on every attempt and a growing oldest
  pending age, and the operator follows the runbook in `docs/standards/audit.md`.

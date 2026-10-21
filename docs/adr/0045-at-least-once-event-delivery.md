# ADR-0045: At-least-once event delivery - always-on outbox, redelivery, dead-letter, dedup

**Date**: 2026-10-13
**Status**: Accepted
**Amends**: [ADR-0017](./0017-extraction-readiness-manifest-outbox-command-ports.md) (outbox no longer opt-in), [ADR-0030](./0030-distributed-only-production-seams.md) (the Redis Streams broker's ACK and retention semantics).

## Context

The event path claimed at-least-once delivery but lost or duplicated events in six places:

1. **The outbox was opt-in.** Without `OUTBOX_ENABLED` every money and compliance event went
   through `emit()`, a fire-and-forget publish after commit. A broker blip or a crash between
   commit and publish lost the event; a rolled-back transaction could still publish one.
2. **A failing handler lost its event.** The Redis Streams broker XACKed every entry after
   dispatch, whether or not a handler threw. Nothing ever retried it.
3. **Retention was a count.** `MAXLEN ~ 10000` per stream dropped unread entries on a busy topic
   within minutes, long before a lagging group caught up.
4. **No consumer-side dedup.** A redelivered event re-ran every handler, including the ones
   that had already succeeded.
5. **The relay was single-writer.** Every replica polled the same pending rows with no claim,
   so two replicas published the same row twice, and one failing row stopped the batch behind it.
6. **Invalid payloads were logged and delivered anyway**, on both the emit and the receive side.

## Decision

**Outbox always on.** `createApp` always binds `DrizzleOutboxWriter` and starts the
`OutboxRelay`; `OUTBOX_ENABLED` is gone. `emitInTransaction(tx, ...)` is the rule for any event
that reports a committed change on a money, compliance, KYC, RG or account-status path: the
event exists if and only if the transaction commits. `emit()` stays for informational,
catalog and cache-invalidation events, where losing one on a broker outage is acceptable.

**ACK only on success, redeliver, then dead-letter.** The broker XACKs an entry only when every
local handler for the topic succeeded. A failed entry stays pending; `XAUTOCLAIM` reclaims it
after it has been idle for 60s (checked every 30s) and redelivers it. On the 5th delivery
(`MAX_DELIVERIES`) a still-failing entry is copied to `oss:dlq:<topic>` with its group, stream
id, delivery count and last error, then XACKed. An entry that is not valid JSON goes straight to
the DLQ. The DLQ is never trimmed; an operator drains it.

**Time-based retention.** Every `XADD` trims with `MINID ~ now - 7d` (`EVENT_RETENTION_MS`).
A group more than 7 days behind loses entries; stream memory is traffic x 7 days. Both are
accepted ceilings; alert on group lag.

**Per-handler dedup in `processed_events`.** Table `processed_events (event_id, consumer)`, PK
on both, owned by the engine `outbox` migration set. `createApp` subscribes each plugin handler
with a stable consumer id `<serviceName>/<owner>/<topic>` (`#n` for the nth extra handler a
plugin registers on the same topic). `EventBus.on` skips a handler whose (eventId, consumer) is
already recorded, runs it, and records it only on success - so a redelivery re-runs only the
handlers that failed.

**Relay with an atomic claim and a lease.** A drain claims a batch in one
`UPDATE ... WHERE event_id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, stamping
`claimed_at`. Concurrent relays never claim the same row inside the 30s lease; a relay that
dies mid-publish leaves its rows to be reclaimed once the lease expires. A row that fails to
publish has its lease released and the rest of the batch carries on. The relay polls every
200ms and, at most once an hour, deletes published outbox rows and `processed_events` rows
older than 7 days.

**Validate at both ends.** `emit`/`emitInTransaction` throw on a known topic whose payload fails
its schema (`emitInTransaction` therefore rolls the caller's transaction back). An inbound
payload that fails validation makes the handler throw, so it follows the redeliver-then-DLQ path.

## Consequences

- Money and compliance events are durable and transaction-atomic. They now publish up to
  ~200ms after commit (relay poll) instead of immediately.
- Handlers must still be idempotent. Dedup is check, run, record: two concurrent deliveries
  of the same event (a reclaim racing a slow first attempt) can both run a handler. Money
  handlers keep their database guards.
- A handler registered through `bus.on` without a `consumer` option is not deduped and re-runs
  on every redelivery of its topic.
- A consumer id is positional for repeat handlers: reordering two handlers a plugin registers
  on the same topic swaps their ids, and in-flight events may re-run them once.
- A poison event retries 5 times over ~5 minutes before it is dead-lettered.
- Every deployment needs the engine outbox migration applied (`0001_event_delivery`).
- Events still on `emit()` (gamification payout notifications, geo access informational events,
  catalog changes) remain best-effort. Moving gamification payouts to `emitInTransaction`
  needs the event threaded into the payout services' transactions.

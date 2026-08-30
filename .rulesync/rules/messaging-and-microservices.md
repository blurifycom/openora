---
root: false
targets:
  - '*'
description: Messaging seams - channel choice and operational safety for events, jobs, realtime, and outbox.
# Scoped to where async seams are used: services (emit/enqueue), plugins (subscribe/
# provide/workers), adapters, module contracts (eventIterator SSE routes) + the core
# contracts zone (event schemas, seam ports), module-root port impls (admin-*.ts),
# the engine, and overlays - not react/schema-only edits.
globs:
  - 'packages/**/service/**'
  - 'packages/**/plugin.ts'
  - 'packages/**/plugins/**'
  - 'packages/**/adapters/**'
  - 'packages/**/contract/**'
  - 'packages/core/src/contracts/**'
  - 'packages/core/src/**/admin-*.ts'
  - 'packages/core/src/server/**'
  - 'packages/testing/**'
  - 'extensions/**'
  - 'tools/create/**'
---

# Messaging and microservices-readiness

Use the seams and contracts in code; this rule owns channel selection and the safety limits that affect a design.

| Need                                        | Channel                                          |
| ------------------------------------------- | ------------------------------------------------ |
| An answer or mutation now, including money  | Synchronous command port                         |
| A fact happened and others may react        | Domain event via `EventBus`                      |
| Durable, retryable, or scheduled work later | `JOB_QUEUE`                                      |
| Server-to-client push                       | `REALTIME_TRANSPORT` with an SSE `eventIterator` |

- Handlers and jobs are at-least-once: they must be idempotent. Money-adjacent work needs a durable database guard, not only an event ID or idempotency key.
- Money and any needed-now answer never travel over events. Use a synchronous, transactional command port.
- `emit()` is best-effort. Use `emitInTransaction()` only when the transactional outbox is explicitly enabled by `OUTBOX_ENABLED`, `AMQP_URL`, or `RABBITMQ_URL`; those AMQP variables enable the outbox but do not bind an AMQP broker.
- A Redis Streams deployment uses `SERVICE_NAME` as its durable consumer-group identity. Every independently deployed service sharing Redis needs a distinct name.
- The shipped Redis Streams and BullMQ drivers do not honor `orderingKey`; use an overlay when strict ordering is required.
- `REALTIME_TRANSPORT` is Redis Pub/Sub (`RedisPubSubRealtimeTransport`, auto-bound on `REDIS_URL`, no in-process fallback - ADR-0031) - fire-and-forget UI push, not a durable event: a message published while nobody is subscribed is simply lost, which is why a realtime channel carries a change _signal_ the client refetches, never the state itself. Channels are prefixed with `SERVICE_NAME` for the same cross-deployment isolation reason as the streams broker's consumer group. `RealtimePresence`/`getOnlineUserIds` are replica-local (no shared Redis SET yet), so a multi-instance deployment undercounts rather than reports the true cluster-wide online count.

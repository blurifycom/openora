---
root: false
targets:
  - '*'
description: Messaging seams (broker / job-queue / realtime), the event envelope, and the in-process -> RabbitMQ -> Kafka migration path for extracting microservices.
globs:
  - '**/*'
---

# Messaging and microservices-readiness

This is a modular monolith today, designed so high-impact modules can be extracted into their own services later with zero module-code changes. Three swappable seams carry all async/cross-process traffic. See ADR-0010, ADR-0014, ADR-0016.

## The three seams (all in `@oss/adapters`, default impls in `@oss/core`)

| Seam | Token | For | Default | Durable overlay |
|---|---|---|---|---|
| Inter-module domain events | `MESSAGE_BROKER` | one module reacts to another | in-process `InMemoryBroker` | RabbitMQ (`AMQP_URL`) |
| Background jobs | `JOB_QUEUE` | durable/retryable/scheduled work | in-process `InProcessJobQueue` | BullMQ + Redis (`REDIS_URL`) |
| Client push | `REALTIME_TRANSPORT` | SSE/WS to the browser | in-process transport | managed vendor (Ably/GetStream) |

`MESSAGE_BROKER` is module-to-module. `REALTIME_TRANSPORT` is server-to-client. Do not conflate them.

## Domain events - always through `EventBus`, never the broker directly

- Declare the payload in `domainEventSchemas` (`@oss/shared-schemas/events.ts`).
- Emit from a service AFTER the DB commit: `this.events.emit('wallet.deposit.completed', { ... })`.
- Subscribe in a plugin: `ctx.events.on('wallet.deposit.completed', (payload) => ...)`.
- Handlers receive the typed PAYLOAD. The full `EventEnvelope` is available as an optional 2nd arg for metadata.

### The event envelope (ADR-0016) - the microservices bridge

The `EventBus` wraps every emission in a serializable envelope at the broker boundary; module code never builds or sees it:

`EventEnvelope` = `{ eventId, topic, payload, occurredAt, schemaVersion }` + optional `{ tenantId, orderingKey, traceId }`.

- `eventId` - consumer-side idempotency/dedup key (a real broker is at-least-once).
- `orderingKey` - Kafka partition key / RabbitMQ routing for per-tenant or per-user ordering.
- `schemaVersion` - forward-compatible payload evolution.
- `tenantId`/`traceId` - lifted from the tenant `AsyncLocalStorage` for correlation.

Because the envelope and the EventBus boundary isolate transport from domain logic, binding a durable broker is an overlay swap (`apps/api/src/extensions/rabbitmq/`) and extracting a module to its own service needs no module edits.

### Migration path: in-process -> RabbitMQ -> Kafka

| Envelope / option | RabbitMQ overlay | Kafka / Redpanda |
|---|---|---|
| `topic` | routing key on the `oss.events` topic exchange | Kafka topic |
| `orderingKey` | (routing) | partition key |
| `consumerGroup` (`SubscribeOptions`) | durable shared queue (competing consumers) | consumer group id |
| `eventId` | `messageId` | idempotent-consumer dedup |

Activate RabbitMQ by setting `AMQP_URL` (eg `amqp://guest:guest@localhost:5672`); `docker compose --profile broker up` starts it. A Kafka adapter is a new overlay implementing `MessageBrokerAdapter` - no module change.

## Rules for async work

- A real broker/queue is **at-least-once** - handlers MUST be idempotent. For money-adjacent handlers/jobs use a DB guard (a unique row / status check), not just `eventId`/`idempotencyKey`.
- Money never flows over events - keep it synchronous and transactional.
- Background work: resolve `JOB_QUEUE`, `enqueue(queue('name'), payload, { idempotencyKey, attempts, backoff, orderingKey })`; a worker overlay registers the handler. BullMQ activates on `REDIS_URL`.
- Client push: publish on `REALTIME_TRANSPORT` and expose an oRPC `eventIterator` served as SSE; bridge push->pull with `createEventStreamGenerator`. Do NOT keep a private listener `Set` in a service - go through the transport seam so a managed vendor fans out across instances (sportsbook odds is the reference adoption).

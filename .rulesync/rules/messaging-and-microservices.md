---
root: false
targets:
  - '*'
description: Messaging seams (broker / job-queue / realtime), the event envelope, and the in-process -> RabbitMQ -> Kafka migration path for extracting microservices.
globs:
  - '**/*'
---

# Messaging and microservices-readiness

This is a modular monolith today, designed so high-impact modules can be extracted into their own services later with zero module-code changes. Three swappable seams carry all async/cross-process traffic, a transactional outbox makes events durable across a process boundary, and a service manifest lets the same codebase boot as the monolith or as a single-module service. See ADR-0010, ADR-0014, ADR-0016, ADR-0017.

## The three seams (all in `@oss/adapters`, default impls in `@oss/core`)

| Seam                       | Token                | For                              | Default                        | Durable overlay                 |
| -------------------------- | -------------------- | -------------------------------- | ------------------------------ | ------------------------------- |
| Inter-module domain events | `MESSAGE_BROKER`     | one module reacts to another     | in-process `InMemoryBroker`    | RabbitMQ (`AMQP_URL`)           |
| Background jobs            | `JOB_QUEUE`          | durable/retryable/scheduled work | in-process `InProcessJobQueue` | BullMQ + Redis (`REDIS_URL`)    |
| Client push                | `REALTIME_TRANSPORT` | SSE/WS to the browser            | in-process transport           | managed vendor (Ably/GetStream) |

`MESSAGE_BROKER` is module-to-module. `REALTIME_TRANSPORT` is server-to-client. Do not conflate them.

## Deployable topology - the service manifest (ADR-0017)

The same codebase boots as the full monolith or as a single-purpose service. `SERVICE_MANIFEST` (comma-separated module ids) selects which modules a process loads; unset = all (monolith). Infra overlays (broker/queue drivers, marked `kind: 'infra'` in `extensions.config.ts`) always load. Filtering lives in `applyServiceManifest` (`@oss/plugin-host`), applied in `apps/api/src/extensions.ts`.

- Run a subset on the existing host: `SERVICE_MANIFEST=identity,wallet pnpm -F @oss/api dev`.
- Scaffold a dedicated thin host: `pnpm create:service <name> <modules>` -> `apps/<name>/` that bakes the manifest and reuses the root `extensions.config.ts` (module code is never copied).
- A manifest must include a module's `dependsOn` deps (topo-sort fails fast otherwise). To run two split services that still exchange events, bind a durable broker (`AMQP_URL`) so events cross the process boundary.

## Choose the channel: command vs event vs job

| Need                                              | Channel                      | How                                                                          |
| ------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| "I need an answer / a mutation now" (incl. money) | **synchronous command port** | a `@oss/adapters` port (eg `WALLET_COMMANDS`), called in-process - see below |
| "this happened, others may react"                 | **domain event**             | `EventBus` (`MESSAGE_BROKER`)                                                |
| "do this reliably later"                          | **background job**           | `JOB_QUEUE`                                                                  |

Never move money or a needed-now answer over events.

## Synchronous cross-module commands - command ports (ADR-0017)

When module A must mutate or query module B _synchronously_ (money, a value it needs now), it goes through a **command port** that B owns - not by importing B's tables. Reference: sportsbook debits the wallet via `WALLET_COMMANDS.debit(tx, { userId, amount })`, passing its own transaction handle, so bet-insert + debit stay atomic in-process. The wallet module binds the default `WalletCommandsService`; a remote wallet service later binds an implementation that runs a saga - the caller is unchanged. Declare `dependsOn: ['<owner>']` in the consumer's plugin so the port is registered first and load order is pinned for a future split.

## Domain events - always through `EventBus`, never the broker directly

- Declare the payload in `domainEventSchemas` (`@oss/shared-schemas/events.ts`).
- Emit from a service AFTER the DB commit: `this.events.emit('wallet.deposit.completed', { ... })` (best-effort, in-process fan-out), OR emit durably inside the transaction with the outbox (below) when the event must not be lost.
- Subscribe in a plugin: `ctx.events.on('wallet.deposit.completed', (payload) => ...)`.
- Handlers receive the typed PAYLOAD. The full `EventEnvelope` is available as an optional 2nd arg for metadata.
- Versioning: bump the event in `domainEventVersions` (sparse map; default 1) in the SAME commit that changes its payload shape; the envelope carries `getEventVersion(topic)`. `eventCatalog()` lists every topic + version (for broker topic provisioning and producer/consumer agreement).

### Transactional outbox - durable, transaction-atomic events (ADR-0017)

`emit()` is best-effort fan-out (lost if the broker is down between commit and publish). For an event that must survive a crash - or a process boundary once the module is its own service - use the outbox:

- In the service, INSIDE `db.transaction`, call `await this.events.emitInTransaction(tx, 'topic', payload)`. The envelope is written to the `event_outbox` table within the same transaction (atomic with the state change). The `OutboxRelay` publishes pending rows to the broker after commit and stamps `publishedAt`. Delivery is at-least-once; consumers dedup on `eventId`.
- Bound only when enabled: `OUTBOX_ENABLED=1` or a durable broker (`AMQP_URL`). Off in the default in-process monolith, where `emit()`'s synchronous fan-out is enough and `emitInTransaction` throws a guiding error. Port `OUTBOX` (`@oss/adapters`), impl `DrizzleOutboxWriter` + `OutboxRelay` (`@oss/db`), wired in `create-app`.

### The event envelope (ADR-0016) - the microservices bridge

The `EventBus` wraps every emission in a serializable envelope at the broker boundary; module code never builds or sees it:

`EventEnvelope` = `{ eventId, topic, payload, occurredAt, schemaVersion }` + optional `{ orderingKey, traceId }`.

- `eventId` - consumer-side idempotency/dedup key (a real broker is at-least-once).
- `orderingKey` - Kafka partition key / RabbitMQ routing for per-user ordering.
- `schemaVersion` - forward-compatible payload evolution.
- `traceId` - lifted from the trace context for correlation (ADR-0026: tenantId removed).

Because the envelope and the EventBus boundary isolate transport from domain logic, binding a durable broker is an overlay swap (`apps/api/src/extensions/rabbitmq/`) and extracting a module to its own service needs no module edits.

### Migration path: in-process -> RabbitMQ -> Kafka

| Envelope / option                    | RabbitMQ overlay                               | Kafka / Redpanda          |
| ------------------------------------ | ---------------------------------------------- | ------------------------- |
| `topic`                              | routing key on the `oss.events` topic exchange | Kafka topic               |
| `orderingKey`                        | (routing)                                      | partition key             |
| `consumerGroup` (`SubscribeOptions`) | durable shared queue (competing consumers)     | consumer group id         |
| `eventId`                            | `messageId`                                    | idempotent-consumer dedup |

Activate RabbitMQ by setting `AMQP_URL` (eg `amqp://guest:guest@localhost:5672`); `docker compose --profile broker up` starts it. A Kafka adapter is a new overlay implementing `MessageBrokerAdapter` - no module change.

## Rules for async work

- A real broker/queue is **at-least-once** - handlers MUST be idempotent. For money-adjacent handlers/jobs use a DB guard (a unique row / status check), not just `eventId`/`idempotencyKey`.
- Money never flows over events - keep it synchronous and transactional.
- Background work: resolve `JOB_QUEUE`, `enqueue(queue('name'), payload, { idempotencyKey, attempts, backoff, orderingKey })`; a worker overlay registers the handler. BullMQ activates on `REDIS_URL`.
- Client push: publish on `REALTIME_TRANSPORT` and expose an oRPC `eventIterator` served as SSE; bridge push->pull with `createEventStreamGenerator`. Do NOT keep a private listener `Set` in a service - go through the transport seam so a managed vendor fans out across instances (sportsbook odds is the reference adoption).

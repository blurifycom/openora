---
root: false
targets:
  - '*'
description: Messaging seams (broker / job-queue / realtime), command vs event vs job, the event envelope, outbox, and the service-manifest path to microservices.
globs:
  - 'packages/**'
  - 'extensions/**'
---

# Messaging and microservices-readiness

A modular monolith today, designed so high-impact modules extract into their own services later with zero module-code changes. Three swappable seams carry all async/cross-process traffic; a transactional outbox makes events durable; a service manifest boots the same codebase as monolith or single-module service. ADR-0010/0014/0016/0017.

## The three seams (ports in `packages/core/src/contracts/adapters/`, default impls in core)

| Seam                       | Token                | For                              | Default                        | Durable overlay                 |
| -------------------------- | -------------------- | -------------------------------- | ------------------------------ | ------------------------------- |
| Inter-module domain events | `MESSAGE_BROKER`     | one module reacts to another     | in-process `InMemoryBroker`    | RabbitMQ (`AMQP_URL`)           |
| Background jobs            | `JOB_QUEUE`          | durable/retryable/scheduled work | in-process `InProcessJobQueue` | BullMQ + Redis (`REDIS_URL`)    |
| Client push                | `REALTIME_TRANSPORT` | SSE/WS to the browser            | in-process transport           | managed vendor (Ably/GetStream) |

`MESSAGE_BROKER` is module-to-module. `REALTIME_TRANSPORT` is server-to-client. Do not conflate them.

## Choose the channel: command vs event vs job

| Need                                              | Channel                      | How                                                          |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| "I need an answer / a mutation now" (incl. money) | **synchronous command port** | an adapter-port token the owner binds (eg `WALLET_COMMANDS`) |
| "this happened, others may react"                 | **domain event**             | `EventBus` (`MESSAGE_BROKER`)                                |
| "do this reliably later"                          | **background job**           | `JOB_QUEUE`                                                  |

Never move money or a needed-now answer over events.

## Synchronous cross-module commands - command ports (ADR-0017)

When module A must mutate/query module B synchronously, it goes through a command port B owns - never B's tables. Reference: sportsbook debits the wallet via `WALLET_COMMANDS.debit(tx, { userId, amount })`, passing its own transaction handle so bet-insert + debit stay atomic in-process. A remote wallet service later rebinds the port with a saga impl - the caller is unchanged. Declare `dependsOn: ['<owner>']` in the consumer's plugin.

## Domain events - always through `EventBus`, never the broker directly

- Declare the payload in `domainEventSchemas` (`packages/core/src/contracts/schemas/events.ts`).
- Emit from a service AFTER the DB commit: `this.events.emit('wallet.deposit.completed', {...})` (best-effort fan-out), OR durably inside the transaction via the outbox (below) when the event must not be lost.
- Subscribe in a plugin: `ctx.events.on('wallet.deposit.completed', (payload) => ...)`. Handlers receive the typed payload; the full `EventEnvelope` is an optional 2nd arg.
- Versioning: bump `domainEventVersions` (sparse map; default 1) in the SAME commit that changes a payload shape. `eventCatalog()` lists every topic + version.

### Transactional outbox (ADR-0017)

`emit()` is best-effort (lost if the broker is down between commit and publish). For a must-not-lose event - or across a process boundary - call `await this.events.emitInTransaction(tx, 'topic', payload)` INSIDE `db.transaction`: the envelope is written to `event_outbox` atomically with the state change; the `OutboxRelay` publishes after commit. At-least-once - consumers dedup on `eventId`. Bound only when `OUTBOX_ENABLED=1` or a durable broker is set; in the default in-process monolith `emitInTransaction` throws a guiding error.

### The event envelope (ADR-0016)

The `EventBus` wraps every emission at the broker boundary; module code never builds or sees it. `EventEnvelope` = `{ eventId, topic, payload, occurredAt, schemaVersion }` + optional `{ orderingKey, traceId }`:

- `eventId` - consumer-side idempotency/dedup key (real brokers are at-least-once).
- `orderingKey` - Kafka partition key / RabbitMQ routing for per-user ordering.
- `schemaVersion` - forward-compatible payload evolution. `traceId` - correlation.

Because the envelope isolates transport from domain logic, binding a durable broker is an overlay swap (a `definePlugin` re-providing `MESSAGE_BROKER`) and extracting a module needs no module edits. Migration path: in-process -> RabbitMQ (set `AMQP_URL`; `docker compose --profile broker up`) -> Kafka (a new overlay implementing `MessageBrokerAdapter`); `topic` maps to routing key/topic, `orderingKey` to partition key, `consumerGroup` to durable queue/consumer group, `eventId` to dedup.

## Deployable topology - the service manifest (ADR-0017)

`SERVICE_MANIFEST` (comma-separated module ids) selects which modules a process loads; unset = all (monolith). Infra overlays (`kind: 'infra'` in `extensions.config.ts`) always load; filtering lives in `applyServiceManifest` (`@blurifycom/core/server`).

- Run a subset: `SERVICE_MANIFEST=identity,wallet <your-app-dev-cmd>`.
- Scaffold a thin host: `pnpm create:service <name> <modules>` -> `apps/<name>/` baking the manifest, reusing the root `extensions.config.ts`.
- A manifest must include each module's `dependsOn` deps (topo-sort fails fast). Split services exchanging events need a durable broker (`AMQP_URL`).

## Rules for async work

- Handlers MUST be idempotent (at-least-once delivery). Money-adjacent handlers/jobs use a DB guard (unique row / status check), not just `eventId`/`idempotencyKey`.
- Money never flows over events - synchronous and transactional, via a command port.
- Background work: `enqueue(queue('name'), payload, { idempotencyKey, attempts, backoff, orderingKey })`; a worker overlay registers the handler via `ctx.jobs.worker(...)`.
- Client push: publish on `REALTIME_TRANSPORT`, expose an oRPC `eventIterator` served as SSE, bridge push->pull with `createEventStreamGenerator`. No private listener `Set`s in services - go through the seam so a managed vendor can fan out across instances.

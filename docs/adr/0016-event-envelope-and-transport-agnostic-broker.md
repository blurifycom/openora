# ADR-0016: Event envelope and transport-agnostic message broker

**Date**: 2026-06-09
**Status**: Accepted; implemented (envelope at the `MESSAGE_BROKER` boundary, EventBus owns it, RabbitMQ overlay as the reference durable driver, in-process default unchanged).
**Amended by ADR-0026 (2026-06-18)**: the envelope's `tenantId` field was removed when the platform went single-tenant. `eventId`/`topic`/`payload`/`occurredAt`/`schemaVersion` + optional `orderingKey`/`traceId` remain.

## Context

ADR-0010 chose event-driven inter-module communication behind a `MESSAGE_BROKER`
seam, defaulting to an in-process broker and deferring the durable driver until a
real need arose. The platform is a modular monolith now, but high-impact modules
(wallet, gaming, sportsbook) are expected to be extracted into their own services
later. The first downstream consumer wants a durable queue set up today (RabbitMQ
or BullMQ) and a clean migration path to Kafka/Redpanda later.

The broker interface as it stood was too thin to swap cleanly:

```ts
// before
publish(topic: string, payload: unknown): void | Promise<void>;
subscribe(topic: string, handler: (payload: unknown) => void): void;
```

There was no envelope on the wire, so a remote adapter had nothing to carry
correlation or routing metadata: no `eventId` (consumer-side dedup), no
`orderingKey` (Kafka partition key / RabbitMQ routing), no `schemaVersion`
(payload evolution), no `tenantId`/`traceId` (correlation). `subscribe` returned
`void` (no unsubscribe) and there was no `close()` for teardown of remote
connections.

## Decision

Introduce a serializable **event envelope** at the `MESSAGE_BROKER` boundary and
make the interface closeable and unsubscribable. Module code is unchanged: it
still emits and subscribes through the `EventBus`, which owns the envelope.

```ts
export interface EventEnvelope<T = unknown> {
  eventId: string; // UUID per emission - consumer-side idempotency/dedup
  topic: string; // domain event name, eg "wallet.deposit.completed"
  payload: T; // validated payload (matches domainEventSchemas)
  occurredAt: string; // ISO-8601 emission timestamp
  schemaVersion: number; // monotonic - forward-compatible payload evolution
  tenantId?: string; // pulled from tenant AsyncLocalStorage when present
  orderingKey?: string; // Kafka partition key / RabbitMQ routing for ordering
  traceId?: string; // distributed-trace correlation
}

export interface MessageBrokerAdapter {
  publish(envelope: EventEnvelope): void | Promise<void>;
  subscribe(topic: string, handler: BrokerHandler, options?: SubscribeOptions): () => void;
  close(): Promise<void>;
}
```

- The **EventBus** (`@openora/core`) builds the envelope on `emit` (generates
  `eventId`, stamps `occurredAt`, sets `schemaVersion: 1`, lifts `tenantId`/
  `traceId` from the tenant `AsyncLocalStorage`), validates `payload` against
  `domainEventSchemas` (logs on mismatch but never drops), and on `subscribe`
  unwraps the envelope so module handlers receive the typed **payload** - with the
  full envelope available as an optional second argument for handlers that want
  metadata. The public typed `EventBus` API is unchanged.
- The default in-process `InMemoryBroker` implements the new interface (synchronous
  fan-out, per-subscriber error isolation, `subscribe` returns an unsubscribe fn,
  `close()` clears handlers). `createApp` registers `onDispose(() => broker.close())`.
- A **RabbitMQ overlay** (`apps/api/src/extensions/rabbitmq/`) is the reference
  durable driver. Self-disabling: it rebinds `MESSAGE_BROKER` only when `AMQP_URL`
  (or `RABBITMQ_URL`) is set, otherwise the in-process default stays (safe for
  dev/test/CI). It uses one topic exchange (`oss.events`), routes by
  `envelope.topic`, creates a durable shared queue per `consumerGroup` (competing
  consumers) or an exclusive per-process queue (fan-out), and acks/nacks per
  handler outcome. Registered last in `extensions.config.ts` (last registration
  wins). `docker compose --profile broker up` starts RabbitMQ for local testing.

## Forward mapping to Kafka / Redpanda

The envelope and `SubscribeOptions` were chosen so a Kafka adapter is a drop-in
overlay with zero module changes:

| Envelope / option           | RabbitMQ overlay                               | Kafka / Redpanda                                        |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `topic`                     | routing key on the `oss.events` topic exchange | Kafka topic                                             |
| `orderingKey`               | (routing only today)                           | partition key - preserves per-tenant/user order         |
| `consumerGroup`             | durable shared queue name                      | consumer group id                                       |
| `eventId`                   | `messageId` property                           | idempotent-consumer dedup key                           |
| `payload` + `schemaVersion` | JSON body                                      | JSON/Avro body; version gates schema-registry evolution |

## Consequences

- Once a remote broker is bound, delivery is **at-least-once** - consumers must be
  idempotent (a DB guard, not just `eventId`, for money-adjacent handlers). This
  matches the `JOB_QUEUE` rule in ADR-0014.
- Extracting a module into its own service becomes an overlay swap plus a
  deployment topology change - no module code edits, because the envelope and the
  EventBus boundary already isolate transport from domain logic.
- Synchronous same-tick delivery is an in-process-only property. Tests that relied
  on a subscriber observing a side effect before `emit` returns must not assume it
  under a remote broker. The EventBus already fires publish as fire-and-forget.
- `amqplib` is added as a dependency of `@openora/api` (alongside `bullmq`), used only
  by the opt-in overlay. It ships its own types; no `@types/amqplib`.

## References

- ADR-0010 - event-driven broker and microservices direction (this refines it).
- ADR-0014 - `JOB_QUEUE` + `REALTIME_TRANSPORT` seams and the BullMQ overlay pattern this mirrors.

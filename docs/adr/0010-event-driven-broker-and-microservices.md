# ADR-0010: Event-driven module communication, broker seam, and the path to microservices

**Date**: 2026-05-27
**Status**: Accepted; foundation implemented (typed bus + broker seam + wiring + atomic money). Only a concrete durable driver remains - see "Implementation backlog".
**Superseded in part by [ADR-0030](./0030-distributed-only-production-seams.md) (2026-07-16)**: the in-process `InMemoryBroker` default was removed from the production path - production is distributed-only, `createApp` now requires a durable `MESSAGE_BROKER` binding and throws otherwise. `REDIS_URL` auto-binds the in-core `RedisStreamsBroker` reference driver; RabbitMQ/Kafka remain overlay swaps. `InMemoryBroker` survives as a test-only double (`@openora/core/testing`). Everything else here (event-driven decoupling, the broker seam shape, synchronous/atomic money, modular-monolith-now-extract-later) still stands.

> **Update (2026-07-25)**: [ADR-0032](./0032-tests-run-the-production-seams.md) deleted `InMemoryBroker` outright - the test suite binds `RedisStreamsBroker` too, so the "survives as a test-only double" clause above no longer holds. Nothing else in this ADR changes.

## Context

Modules must stay decoupled so the platform scales both in load and in team/organisational terms, and so an operator can extract a hot module into its own service later. Today modules already communicate via an in-process `EventBus` (`EVENT_BUS`) and read each other's tables through the `@openora/modules/<group>/<name>/schema` subpath - never by importing another module. We want to make event-driven communication the primary, intentional pattern and define how it grows into a real broker and, eventually, microservices - without committing to a broker product prematurely.

## Decision

**1. Event-driven between modules; synchronous + atomic for money.**

- Cross-module side effects (bonuses, AML checks, personalization, leaderboards, notifications) are driven by **events on topics**: a module emits, any number of modules subscribe (fan-out). Subscribers are independent and idempotent.
- **Money and gating stay synchronous and transactional.** Placing a bet (`wallet` debit, balance check, RGS result) and pre-action gates (KYC/jurisdiction) are atomic operations inside a single service/transaction - never "fire an event and hope". Events describe what already happened; they do not move funds.

**2. The API is a gateway over events, not the system of record for them.**

- The oRPC/HTTP layer is a backend-for-frontend: it triggers commands and serves reads. It does not couple modules together; modules couple to topics, not to each other's routes.

**3. Broker behind an adapter seam; driver chosen later.**

- A `MessageBrokerAdapter` interface + `MESSAGE_BROKER` token will live in `@openora/adapters`, mirroring the existing six vendor seams. The default binding stays the in-process `InMemoryEventBus`; production binds a durable driver.
- **Recommendation when we get there:** for regulated real-money igaming the audit/ledger/replay requirement favours a durable, ordered, replayable log - a **Kafka-compatible** backbone. Prefer **Redpanda** (Kafka API, no JVM/ZooKeeper, lower ops) for the financial/audit stream; **NATS JetStream** is the lighter option for early stage or ephemeral fan-out. RabbitMQ/SQS are acceptable for at-least-once work queues. Delivery is **at-least-once**, so consumers must be idempotent.

**4. Client push is separate from inter-module transport.**

- WebSockets/SSE are **client-facing only** (chat, balance/bonus toasts). They are not used between modules (no delivery guarantee/ack). A module reacts to a broker event and may then push to a connected client over WS/SSE at the edge.

**5. Microservices: modular monolith now, extract later.**

- Ship a **modular monolith**. The module-isolation rules (no cross-module imports; communicate via events or schema-subpath reads) plus the broker seam already make a module extractable: point its `MESSAGE_BROKER` at the shared broker, give it its own deployable, and its events keep flowing. Likely first extractions: `bonus`, `aggregator`/personalization. Avoid >2-hop synchronous call chains across service boundaries.

## Consequences

**Positive:** modules scale and deploy independently over time; the broker is a swappable transport, not a rewrite; the audit trail is a first-class design goal, not an afterthought.

**Negative / trade-offs:** event-driven flows are harder to trace than direct calls (mitigate with topic documentation per module and correlation IDs); at-least-once delivery pushes idempotency onto every consumer.

## Implementation status

Done:

1. **Typed event catalog.** `domainEventSchemas` (Zod) in `@openora/shared-schemas` (`events.ts`) is the single source for every cross-module event payload; `DomainEventName`/`DomainEventPayload` are inferred from it.
2. **Broker seam.** `MessageBrokerAdapter` + `MESSAGE_BROKER` token in `@openora/adapters`. The `EventBus` (`@openora/core`) is a typed facade over it that validates known payloads and isolates subscriber failures. Default binding is `InMemoryBroker` (synchronous in-process fan-out); bind a durable driver to `MESSAGE_BROKER` in an overlay to swap transport - no module change.
3. **Plugin handlers wired.** `createApp` subscribes every `registry.events.getAll()` handler to the resolved bus at boot, so cross-module `ctx.events.on(...)` handlers now actually fire.
4. **Atomic money.** `wallet` deposit/withdraw wrap the ledger insert + balance update in `db.transaction(...)` (withdraw re-checks the balance inside the txn to block double-spend) and emit only after commit.

Open:

- **A concrete durable driver** (Redpanda / Kafka API or NATS JetStream) implementing `MessageBrokerAdapter`, plus a docker-compose service - deferred until a real microservice split needs it. Until then the in-process default is correct for the modular monolith.

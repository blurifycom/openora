# ADR-0010: Event-driven module communication, broker seam, and the path to microservices

**Date**: 2026-05-27
**Status**: Accepted (design); implementation staged - see "Implementation backlog"

## Context

Modules must stay decoupled so the platform scales both in load and in team/organisational terms, and so an operator can extract a hot module into its own service later. Today modules already communicate via an in-process `EventBus` (`EVENT_BUS`) and read each other's tables through the `@oss/modules/<group>/<name>/schema` subpath - never by importing another module. We want to make event-driven communication the primary, intentional pattern and define how it grows into a real broker and, eventually, microservices - without committing to a broker product prematurely.

## Decision

**1. Event-driven between modules; synchronous + atomic for money.**

- Cross-module side effects (bonuses, AML checks, personalization, leaderboards, notifications) are driven by **events on topics**: a module emits, any number of modules subscribe (fan-out). Subscribers are independent and idempotent.
- **Money and gating stay synchronous and transactional.** Placing a bet (`wallet` debit, balance check, RGS result) and pre-action gates (KYC/jurisdiction) are atomic operations inside a single service/transaction - never "fire an event and hope". Events describe what already happened; they do not move funds.

**2. The API is a gateway over events, not the system of record for them.**

- The oRPC/HTTP layer is a backend-for-frontend: it triggers commands and serves reads. It does not couple modules together; modules couple to topics, not to each other's routes.

**3. Broker behind an adapter seam; driver chosen later.**

- A `MessageBrokerAdapter` interface + `MESSAGE_BROKER` token will live in `@oss/adapters`, mirroring the existing six vendor seams. The default binding stays the in-process `InMemoryEventBus`; production binds a durable driver.
- **Recommendation when we get there:** for regulated real-money igaming the audit/ledger/replay requirement favours a durable, ordered, replayable log - a **Kafka-compatible** backbone. Prefer **Redpanda** (Kafka API, no JVM/ZooKeeper, lower ops) for the financial/audit stream; **NATS JetStream** is the lighter option for early stage or ephemeral fan-out. RabbitMQ/SQS are acceptable for at-least-once work queues. Delivery is **at-least-once**, so consumers must be idempotent.

**4. Client push is separate from inter-module transport.**

- WebSockets/SSE are **client-facing only** (chat, balance/bonus toasts). They are not used between modules (no delivery guarantee/ack). A module reacts to a broker event and may then push to a connected client over WS/SSE at the edge.

**5. Microservices: modular monolith now, extract later.**

- Ship a **modular monolith**. The module-isolation rules (no cross-module imports; communicate via events or schema-subpath reads) plus the broker seam already make a module extractable: point its `MESSAGE_BROKER` at the shared broker, give it its own deployable, and its events keep flowing. Likely first extractions: `bonus`, `aggregator`/personalization. Avoid >2-hop synchronous call chains across service boundaries.

## Consequences

**Positive:** modules scale and deploy independently over time; the broker is a swappable transport, not a rewrite; the audit trail is a first-class design goal, not an afterthought.

**Negative / trade-offs:** event-driven flows are harder to trace than direct calls (mitigate with topic documentation per module and correlation IDs); at-least-once delivery pushes idempotency onto every consumer.

## Implementation backlog (not done in this round - documentation only)

1. **Wire plugin event handlers.** `ctx.events.on(...)` handlers are collected into the registry but **not yet subscribed to the bus** at boot - cross-module events do not fire today. Wire `registry.events.getAll()` into the resolved `EVENT_BUS` in `createApp`.
2. **Make wallet ops transactional.** `wallet` deposit/withdraw currently run separate statements around the PSP call; wrap the ledger write + balance update in `db.transaction(...)`.
3. **Define the `MessageBrokerAdapter` seam** in `@oss/adapters` and a Redpanda/NATS binding behind it; keep `InMemoryEventBus` as the default.

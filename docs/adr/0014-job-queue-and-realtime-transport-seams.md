# ADR-0014: Background-job (`JOB_QUEUE`) and realtime-transport (`REALTIME_TRANSPORT`) seams

**Date**: 2026-05-29
**Status**: Accepted; foundation implemented (both seams + in-process defaults + wiring; BullMQ overlay as the reference durable driver; first-party SSE chat as the reference realtime vertical).

## Context

Two foundational capabilities were missing as the first downstream consumer
began selecting vendors (EveryMatrix, Fireblocks, Ably/GetStream, Text.com, SumSub):

1. **No background-job/worker queue.** Cross-module side effects that must be durable,
   retryable and/or scheduled - webhook ingestion (PSP/aggregator/chat vendors retry
   aggressively), payout retries, KYC polling, aggregator catalog sync, bonus expiry -
   had nowhere to run. `AGENTS.md` already promised a "BullMQ worker overlay" but no
   seam existed.
2. **No realtime transport.** The `chat` module persisted messages and emitted a domain
   event but never pushed to clients. ADR-0007 decided chat should run over the
   platform's own realtime transport behind a swappable `ChatTransportPort`.

This refines ADR-0010 (which deferred the durable `MESSAGE_BROKER` driver and kept
client push separate from the inter-module broker) and realizes ADR-0007.

## Decision

**1. Two new adapter seams, vendor-neutral, default to zero-dependency in-process impls.**

- `JOB_QUEUE` (`@openora/adapters` `job-queue.ts`) - `JobQueueAdapter`: `enqueue`, `schedule`,
  `unschedule`, `registerWorker`, `close`. Supports `idempotencyKey`, `orderingKey`,
  `delayMs`, `attempts` + `backoff`, `priority`, `ttlMs`, and a per-worker Zod `schema`
  validated before the handler runs. Default binding `InProcessJobQueue` (`@openora/core`):
  microtask/`setTimeout` dispatch, retry+backoff, per-`orderingKey` serial lanes,
  dead-letter hook, drain-on-`close`.
- `REALTIME_TRANSPORT` (`@openora/adapters` `realtime.ts`) - `RealtimeTransport`: `publish`,
  `subscribe` (returns unsubscribe), optional `presence`. Default binding
  `InProcessRealtimeTransport` (`@openora/core`): in-process channel fan-out consumed by oRPC
  `eventIterator` SSE handlers. Realizes ADR-0007's `ChatTransportPort` as a generic
  primitive (gaming PvP will reuse it).

Both are wired in `@openora/api-runtime` `create-app.ts` next to `MESSAGE_BROKER`/`EVENT_BUS`.
Workers are collected via a new `ctx.jobs.worker(...)` plugin-host collector (mirrors
`ctx.events.on`) and started at boot against the resolved `JOB_QUEUE`.

**2. Job queue product: BullMQ + Redis (the reference durable driver).**

After an igaming-domain + engineering review, BullMQ was chosen for the durable driver:
it is the only option with native delayed + repeatable (cron) + backoff + dead-letter in
TypeScript, and Redis is the lightest "real" dependency for self-hosters. Kafka/Redpanda
is a poor job queue (no per-message retry/DLQ/delay); RabbitMQ needs plugins to match and
is not a replayable log. The driver lives as an opt-in overlay
(`apps/api/src/extensions/bullmq/`) that owns its `bullmq` dependency and **self-disables
when `REDIS_URL` is unset**, so `pnpm dev`, seed, tests and CI run with no Redis.

**3. Durable `MESSAGE_BROKER` driver stays deferred (per ADR-0010).**

The job queue and the inter-module event log are **separate seams, separate products** -
conflating them makes one tool fake the other. The durable broker driver (Redpanda as the
audit-grade default; NATS JetStream as the lighter self-host option) remains deferred until
a real microservice split needs it; the in-process broker is correct for the modular
monolith. Crucially, 5-10yr MGA/UKGC audit retention is satisfied by the **Postgres
append-only ledger**, not by broker retention - so there is no pressure to adopt Kafka
early.

**4. Realtime is client-facing only, never inter-module.**

`REALTIME_TRANSPORT` carries client push (best-effort, at-most-once for late joiners); the
DB stays the system of record (clients backfill via a normal query, then attach the live
stream). Money and moderation are first-party domain logic, never delegated to the
transport. A managed vendor (Ably/GetStream) is a single token rebind downstream.

## Consequences

**Positive:** durable retryable jobs and live push are first-class, both swappable behind
tokens; the default path needs no extra infra; consumers bind their own driver/vendor with
one overlay; matches the existing adapter-seam philosophy (ADR-0002).

**Negative / trade-offs:** at-least-once delivery pushes idempotency onto every job/event
consumer (money jobs need a DB unique guard, not just `idempotencyKey`); the free BullMQ
driver does not enforce strict per-`orderingKey` ordering (the in-process default does) -
documented in the overlay's AGENTS.md; the realtime layer's scaling (fan-out,
reconnection) is owned by the operator unless they bind a managed vendor.

## Implementation status

Done: both seams + tokens (`@openora/adapters`); in-process defaults + barrel exports
(`@openora/core`); `ctx.jobs.worker` collector (`@openora/plugin-host`); `create-app.ts` bindings +
worker-registration loop + drain ordering; BullMQ overlay (`apps/api/src/extensions/bullmq/`,
self-disabling, registered in `extensions.config.ts`); chat realtime vertical
(`chat.streamMessages` SSE route, service publish, `useChatStream` hook, `PlayerChatPage`);
unit tests (job queue: delay/retry/DLQ/ordering/dedupe/drain; realtime transport;
chat wiring).

Open: durable `MESSAGE_BROKER` driver (deferred, ADR-0010); chat economy commands
`/tip` `/rain` `/gift` (ADR-0007 #2, wallet/bonus domain); refactor the sportsbook odds feed
onto `REALTIME_TRANSPORT` (would validate the abstraction).

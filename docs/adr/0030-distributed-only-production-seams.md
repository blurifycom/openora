# ADR-0030: Distributed-only production - in-process seams removed from the production path

**Date**: 2026-07-16
**Status**: Accepted
**Supersedes**: [ADR-0010](./0010-event-driven-broker-and-microservices.md), [ADR-0014](./0014-job-queue-and-realtime-transport-seams.md), [ADR-0016](./0016-event-envelope-and-transport-agnostic-broker.md), [ADR-0028](./0028-redis-reference-adapters-cache-rate-limiting.md) (their in-process-default decisions only - the seam interfaces, the event envelope, and the Redis/BullMQ reference drivers those ADRs introduced are unchanged).

## Context

Five seams shipped with an in-process default that silently doubled as the production
binding whenever an operator forgot (or didn't know) to set `REDIS_URL`/bind an
overlay: `MESSAGE_BROKER` (`InMemoryBroker`), `JOB_QUEUE` (`InProcessJobQueue`),
`CACHE` (`InProcessCache`), `RATE_LIMITER` (`InProcessRateLimiter`),
`REALTIME_TRANSPORT` (`InProcessRealtimeTransport`) + `REALTIME_CLIENT_AUTHORIZER`
(`SseClientAuthorizer`). In-process state is per-process. Under horizontal scaling
that means: domain events don't cross replicas (a subscriber on pod B never sees an
event emitted on pod A), rate limits are per-pod (N pods = N x the intended
brute-force budget), cache invalidation doesn't propagate (a stale read survives on
every other pod), and SSE fan-out is local (a message published on pod A never
reaches a client connected to pod B). Nothing stopped a multi-replica deployment
from booting on these defaults and failing this way in production, quietly.

## Decision

**Production is distributed-only.** The in-process impls leave the production code
path entirely:

- `createApp` no longer registers an in-process default for `MESSAGE_BROKER`,
  `JOB_QUEUE`, `CACHE`, or `RATE_LIMITER`. `REDIS_URL` still auto-binds the Redis
  reference drivers (`RedisCache`/`RedisRateLimiter`/`BullMqJobQueue`) exactly as
  before (ADR-0028) - that part is unchanged. `MESSAGE_BROKER` has no in-core
  durable default at all; a deployment must bind an overlay (RabbitMQ/Kafka).
- After `loadPlugins` + `configure` (so a `REDIS_URL` auto-bind or an overlay's own
  registration already won - Container is last-registration-wins), `createApp` calls
  `assertDurableSeamsBound(container)`. It throws a single actionable error listing
  every still-unbound seam among `MESSAGE_BROKER`/`JOB_QUEUE`/`CACHE`/`RATE_LIMITER`
  and how to fix it (set `REDIS_URL`, or bind an overlay). Modeled on
  `assertSealedServicesBound` (`compliance/assert.ts`), except this one runs
  unconditionally inside `createApp` itself rather than being left for a consumer to
  opt into from their own CI.
- `REALTIME_TRANSPORT` (and its `REALTIME_CLIENT_AUTHORIZER` sidekick) is
  deliberately NOT in the required list - it stays unbound and throws only on first
  use. Not every deployment serves realtime traffic, so failing boot for it
  unconditionally would be wrong.
- The five in-process impls survive as **test-only doubles**, relocated to a new
  `packages/core/src/testing/fakes/` and exposed via a new `@openora/core/testing`
  subpath (not the separate `@openora/testing` package - that package depends on
  `@openora/core`, and core's own unit tests need these doubles, so putting them in
  `@openora/testing` would create a `core -> testing -> core` package cycle).
  `bootTestApp` (`@openora/testing`) binds them via a `configure` callback before
  `createApp`'s durable-seam assertion runs, so the existing test suite still boots
  with zero infra.
- Kernel files that mixed a production helper with the in-process impl were split:
  `event-bus.ts` keeps `createEventBus`/`EVENT_BUS`/`EventBus`, `InMemoryBroker`
  moved out; `rate-limiter.ts` keeps `assertRateLimit`/`makeRateLimitError`,
  `InProcessRateLimiter` moved out; `cache.ts` keeps `cached`/`invalidate`,
  `InProcessCache` moved out. `job-queue.ts`, `realtime-transport.ts`, and
  `realtime-authorizer.ts` moved out whole (impl-only files).
- `EventBus.emit()`'s publish call is now wrapped:
  `void Promise.resolve(broker.publish(envelope)).catch(...)` - so a rejection from
  a real async durable-broker publish is logged instead of becoming an unhandled
  promise rejection (the synchronous in-process broker never rejected, so this
  path was previously untested against a real async driver).

## Consequences

**Positive:** a misconfigured multi-replica deployment fails fast and loudly at
boot, with an actionable message, instead of silently corrupting rate limits/cache/
events in production. The test suite is unaffected (zero infra, same 543 unit
tests, now plus a dedicated `create-app` boot test proving both the failure and
the success path).

**Negative / trade-offs:**

- **Single-node zero-dependency production deploy is gone.** Every deployment now
  needs Redis (`REDIS_URL`) plus a durable broker overlay bound before `createApp`
  will finish booting.
- **Core ships no durable `MESSAGE_BROKER`.** A RabbitMQ/Kafka broker overlay is
  now mandatory to run at all - authoring one is necessary follow-up work, tracked
  separately, not part of this change. Until it exists, no deployment boots without
  first binding a broker in an overlay's `plugin.ts`.
- A realtime-vendor overlay (Ably/GetStream) is similarly required for any
  deployment that actually serves realtime traffic (chat, live odds), though
  `createApp` itself doesn't gate boot on it.

## References

- ADR-0010 - original broker seam + in-process default (superseded here).
- ADR-0014 - `JOB_QUEUE`/`REALTIME_TRANSPORT` seams + in-process defaults (superseded here).
- ADR-0016 - event envelope + transport-agnostic broker interface (envelope/interface unchanged; the in-process-default framing is superseded).
- ADR-0028 - Redis reference adapters + `REDIS_URL` auto-bind (auto-bind behavior unchanged; the in-process-fallback framing is superseded).
- ADR-0025 - single-core-package layout (`@openora/core/testing` follows the same subpath pattern as `@openora/core/compliance/sealed`).

# ADR-0028: Redis reference adapters for cache, rate limiting and jobs

**Date**: 2026-07-06
**Status**: Accepted
**Superseded in part by [ADR-0030](./0030-distributed-only-production-seams.md) (2026-07-16)**: the in-process fallback for `CACHE`/`RATE_LIMITER`/`JOB_QUEUE` was removed from the production path - production is distributed-only, `createApp` now requires `REDIS_URL` (auto-binding `RedisCache`/`RedisRateLimiter`/`BullMqJobQueue` exactly as decided here) or an explicit overlay binding, and throws with an actionable error otherwise. `InProcessCache`/`InProcessRateLimiter` survive as test-only doubles (`@openora/core/testing`); dev/test still runs with zero infra via `bootTestApp`. The Redis driver choice, the Lua-script atomic rate limiter, and the fail-open/fail-closed semantics below are unchanged.

## Context

Caching (`CACHE`) and rate limiting (`RATE_LIMITER`) live behind DI ports in
`packages/core/src/contracts/adapters/`, but the only shipped implementations were
in-process (`InProcessCache`, `InProcessRateLimiter`). Both keep state in a
process-local `Map`. On a multi-replica deployment that means per-pod rate limits
(N pods = N x the intended brute-force budget) and cache invalidation that does not
propagate across replicas (stale cms/iam reads after a revocation). Every call site
already depends only on the port, so the seam is right - what was missing was a
distributed reference implementation, mirroring how RabbitMQ is the reference
`MESSAGE_BROKER` overlay.

## Decision

Ship Redis reference adapters in core, auto-bound when `REDIS_URL` is set.

- `RedisCache` and `RedisRateLimiter` (`packages/core/src/server/kernel/`) implement
  the existing ports over one shared node-redis client (`createRedisClient`).
- `BullMqJobQueue` (`packages/core/src/server/kernel/bullmq-job-queue.ts`) implements the
  `JOB_QUEUE` port so background jobs become durable (survive restarts, real cron) with
  zero consumer code. BullMQ is ioredis-based, so it cannot reuse the node-redis client -
  it owns its own connection(s) built from the same `REDIS_URL`, closed on shutdown.
- `createApp` branches on `process.env['REDIS_URL']`: set -> bind `BullMqJobQueue` plus
  the Redis cache/rate-limiter (over a shared node-redis client, disposed on shutdown);
  unset -> keep the in-process defaults. Same precedent as the `AMQP_URL`/`OUTBOX_ENABLED`
  outbox branch in the same file. The `JOB_QUEUE` disposer drains in-flight jobs before
  the DB closes (DRIZZLE is resolved first; disposers run in reverse).
- The in-process defaults stay the dev/test/seed binding (zero deps, no running
  Redis). A consumer needs zero code - set `REDIS_URL` and get distributed behaviour;
  plugins load after `createApp`, so an overlay can still rebind either token to any
  other backend (Container is last-wins).
- The rate limiter is a fixed window via one atomic Lua script (`INCR` + first-hit
  `PEXPIRE`, returning count + PTTL) so two replicas can't both slip past the limit.
- Opt-in `docker compose --profile redis up` provides a local `redis:7-alpine`.

### Job ordering under the BullMQ driver

`EnqueueOptions.orderingKey` (per-key fan-in serialization) has no equivalent in OSS
BullMQ - ordering groups are a BullMQ Pro feature. The driver warns once per queue and
proceeds unordered; handlers are required idempotent anyway (at-least-once delivery), so
this degrades safely. Strict ordering is restored by BullMQ Pro groups or a custom
overlay rebinding `JOB_QUEUE`. `ttlMs` likewise has no native BullMQ equivalent and is
ignored (the port already documents driver variance).

### Availability semantics: fail-open vs fail-closed

When the backend is unreachable the limiter honours a per-call-site
`onUnavailable` option: `'allow'` (default) keeps availability - throttling simply
pauses during a Redis outage rather than 500-ing every request; `'deny'` fails closed
for the credential-guessing keys (`login:`, `verify2fa:`, `pwreset:`) where an
unthrottled window is worse than a transient 429. The cache always fails open (a miss
degrades to a load) - the `cached()`/`invalidate()` helpers already try/catch, so the
adapter stays honest and only fast-paths on `isReady` to avoid blocking on a
reconnecting socket.

### Why node-redis

Pure-JS (no native bindings), the de-facto official client, and the same `REDIS_URL`
the BullMQ `JOB_QUEUE` driver reuses (BullMQ brings its own ioredis connection - the two
clients coexist on one URL). Pinned exact (v5) per the repo policy.

## Consequences

- Multi-replica deployments get correct distributed rate limits, cross-replica cache
  invalidation and durable background jobs with a single env var, no consumer code.
- Two new runtime dependencies (`redis`, `bullmq`), loaded only when `REDIS_URL` is set;
  dev/test keep zero-dep in-process behaviour.
- Both limiters are fixed-window (a boundary-straddling burst can briefly allow up to
  2x limit) - acceptable for abuse throttling; a sliding window is a later swap.

## Follow-ups

- Cache stampede single-flight and a sliding-window limiter, on evidence.
- Strict `orderingKey` serialization for the BullMQ driver (Pro groups or a custom overlay), on evidence.

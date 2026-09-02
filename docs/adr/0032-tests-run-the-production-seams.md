# ADR-0032: Tests run the production seams - the in-process doubles are deleted

**Date**: 2026-07-25
**Status**: Accepted
**Supersedes**: [ADR-0010](./0010-event-driven-broker-and-microservices.md), [ADR-0014](./0014-job-queue-and-realtime-transport-seams.md), [ADR-0016](./0016-event-envelope-and-transport-agnostic-broker.md), [ADR-0028](./0028-redis-reference-adapters-cache-rate-limiting.md), [ADR-0030](./0030-distributed-only-production-seams.md) (only their "the in-process impl survives as a test-only double" clause - every seam interface, the event envelope, the Redis/BullMQ reference drivers, and the distributed-only production rule are unchanged and still in force)

## Context

[ADR-0030](./0030-distributed-only-production-seams.md) removed the in-process seam
implementations from the production path but kept them alive as test doubles, so the
suite could run with zero infrastructure. `bootTestApp` bound `InMemoryBroker`,
`InProcessJobQueue`, `InProcessCache` and `InProcessRateLimiter` through its
`configure` callback, and the service tests underneath ran against a vi-mocked
Drizzle query builder.

That left the test suite proving a system nobody deploys. The doubles do not merely
approximate the real drivers, they have different semantics:

- `InMemoryBroker` fans out synchronously, so a handler's effect is visible the
  instant `emit()` returns. Redis Streams delivers asynchronously through a consumer
  group, and an event published before a group exists is dropped for good.
- `InProcessJobQueue` runs handlers on the same event loop and dedupes on a JS `Map`
  keyed by the raw `idempotencyKey`. BullMQ persists jobs in Redis and maps that key
  onto a `jobId`, where Redis' own naming rules apply.
- `InProcessCache` and `InProcessRateLimiter` keep per-process state, so nothing in
  the suite exercised cross-replica invalidation or the Lua-scripted atomic counter.

The cost of that gap was not theoretical. Converting the suite surfaced a live
production defect that every green test run had hidden: BullMQ reserves `:` as its
Redis key separator and rejects a custom `jobId` containing one, and
`compliance/plugin.ts` enqueues its RG evaluation with
`idempotencyKey: 'rg-eval:<userId>'`. On any real deployment no `rg-eval` job would
ever have run, so no responsible-gambling flag would ever have been raised - a
regulated feature, silently dead, with a passing test suite on top of it.

The constraint that originally justified the doubles - "the suite must run with zero
infra" - had already lapsed. Postgres was required by then, `docker compose up -d`
starts Redis alongside it, and CI provisions both as service containers. Keeping the
doubles bought nothing and cost a class of undetectable bug.

Two alternatives were considered. **Keeping the doubles for speed** lost because the
measured difference is small (the integration tier runs in ~12s against real Redis)
and the price is exactly the bug class above. **Keeping them as an opt-in fallback
for contributors without Docker** lost because a fallback that is silently selected
is how ADR-0030's original problem arose: the moment a test can pass on semantics the
deployed system lacks, it will, and nobody will notice which path ran.

## Decision

**Every tier of the test suite binds the same drivers production binds.** The four
in-process seam implementations are deleted from the repository rather than
deprecated, so there is no path - explicit or accidental - back to them.

- `bootTestApp` binds `RedisStreamsBroker`, `BullMqJobQueue`, `RedisCache` and
  `RedisRateLimiter`. Each booted app claims its own Redis logical database
  (allocated downward from 15, flushed on boot and on `close()`), so several apps in
  one test file cannot compete for each other's events, jobs, cache entries or
  rate-limit counters. This isolates all four seams at once, which is why it was
  chosen over per-seam key prefixes - those would have required threading a prefix
  option through drivers that production has no reason to carry.
- The broker reads from `startId: '0'` in tests, against production's `$`. A test
  acts within milliseconds of boot, and a group created lazily at `$` would drop
  anything published in that window. Replay is harmless against a flushed database.
- Service and router tests run against real Postgres via `createTestDb`; only
  external vendors and cross-domain ports stay doubled.
- `BullMqJobQueue` percent-encodes an `idempotencyKey` into a valid `jobId`. The
  encoding is injective, so two distinct keys can never collapse onto one job and
  silently dedupe apart. Fixing it in the driver rather than at the one call site
  keeps the `JOB_QUEUE` port's contract honest: callers pass an arbitrary string.
- `InProcessRealtimeTransport` and `SseClientAuthorizer` stay. They are not test
  doubles - `createApp` binds them as the production default because core ships no
  realtime driver at all (ADR-0031). Nothing real exists to replace them with.
  **(Superseded 2026-08-31: ADR-0031 shipped `RedisPubSubRealtimeTransport` and this
  in-process default is deleted. `bootTestApp` now binds the same Redis-backed
  transport production does, same as the other four seams; see ADR-0031's own update
  note for the detail.)**

Postgres and Redis are therefore hard prerequisites for `pnpm verify`, not optional
extras. A missing container fails the run with an actionable `docker compose up -d`
hint rather than degrading to a weaker binding.

## Consequences

**Positive:**

- A green suite now means the code works against the delivery semantics that ship:
  consumer-group fan-out, BullMQ persistence and retries, distributed cache
  invalidation, the atomic rate limiter, and real SQL constraints.
- The bug class that motivated this is closed by construction - a defect that only
  appears against real infra can no longer hide behind a passing test.
- `@openora/core/testing` shrinks to the real-infra harness plus the two realtime
  defaults, so there is one obvious way to write a test.

**Negative / trade-offs:**

- Contributors must run `docker compose up -d`. There is no zero-infra path any more,
  and that is deliberate.
- Event- and job-driven effects are genuinely asynchronous in tests, so they must be
  asserted inside `vi.waitFor(...)`. An assertion written immediately after the
  triggering call will flake rather than fail honestly.
- The suite inherits real-infra failure modes - a wedged container or an exhausted
  connection pool now breaks tests that used to be hermetic.
- Redis logical databases are a finite pool (16). The integration tier allocates
  downward from 15 and the unit harness upward from `VITEST_POOL_ID % 16`; running
  both tiers concurrently against one Redis could collide.

**Neutral:**

- Nothing about the production wiring changes. `REDIS_URL` still auto-binds all four
  seams, ADR-0030's distributed-only rule still holds, and overlays still win by
  last registration.
- `.rulesync/rules/conventions.md` (section 10), `clean-architecture.md` (Testing)
  and `messaging-and-microservices.md` were updated in the same change; the generated
  agent mirrors follow from `pnpm sync:agents`.

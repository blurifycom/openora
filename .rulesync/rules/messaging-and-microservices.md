---
root: false
targets:
  - '*'
description: Messaging seams - channel choice and operational safety for events, jobs, realtime, and outbox.
# Scoped to where async seams are used: services (emit/enqueue), plugins (subscribe/
# provide/workers), adapters, module contracts (eventIterator SSE routes) + the core
# contracts zone (event schemas, seam ports), module-root port impls (admin-*.ts),
# the engine, and overlays - not react/schema-only edits.
globs:
  - 'packages/**/service/**'
  - 'packages/**/plugin.ts'
  - 'packages/**/plugins/**'
  - 'packages/**/adapters/**'
  - 'packages/**/contract/**'
  - 'packages/core/src/contracts/**'
  - 'packages/core/src/**/admin-*.ts'
  - 'packages/core/src/server/**'
  - 'packages/testing/**'
  - 'extensions/**'
  - 'tools/create/**'
---

# Messaging and microservices-readiness

Use the seams and contracts in code; this rule owns channel selection and the safety limits that affect a design.

| Need                                        | Channel                                          |
| ------------------------------------------- | ------------------------------------------------ |
| An answer or mutation now, including money  | Synchronous command port                         |
| A fact happened and others may react        | Domain event via `EventBus`                      |
| Durable, retryable, or scheduled work later | `JOB_QUEUE`                                      |
| Server-to-client push                       | `REALTIME_TRANSPORT` with an SSE `eventIterator` |

- Handlers and jobs are at-least-once: they must be idempotent. Money-adjacent work needs a durable database guard, not only an event ID or idempotency key.
- Money and any needed-now answer never travel over events. Use a synchronous, transactional command port.
- An event reporting a committed change on a money, compliance, KYC, RG or account-status path uses `emitInTransaction(tx, ...)` inside the same transaction (the outbox is always on). `emit()` is best-effort and only for informational, catalog and cache-invalidation events. Both throw on an invalid payload.
- A throwing handler is redelivered and dead-lettered to `oss:dlq:<topic>` after 5 deliveries (ADR-0045); plugin handlers are deduped per consumer via `processed_events`, a bare `bus.on` without a `consumer` is not.
- A Redis Streams deployment uses `SERVICE_NAME` as its durable consumer-group identity. Every independently deployed service sharing Redis needs a distinct name. A subscription that must run once per deployment, however many services load its plugin (the audit writer), passes `{ consumerGroup }` as the third argument of `ctx.events.on`; services of one deployment using the same group name compete for each event, and `createApp` scopes the name as `<REALTIME_NAMESPACE>/<group>` so two deployments sharing one Redis do not.
- `SERVICE_MANIFEST` picks the modules a process boots; `createApp` applies it to any plugin list. A manifest lists every module its modules `dependsOn` and every module that binds a port they require; infra overlays always load and their dependencies count. Boot logs each `optionalPorts` entry left unbound with what its module skips. A split fails closed on controls: it refuses to boot while a selected module's `controlPorts` entry (an RG limit, a geo check, an audit record) or `AdminGuard`'s permission resolver or security policy - checked on every manifest boot, which builds the guard before it serves - is unbound and the plugin list has the module that binds it. Whatever is missing fails the boot once, with one manifest line adding every module needed and theirs; with the shipped modules every split carries iam, identity, audit, mail, compliance, wallet, gaming, player-management, exchange-rate and chat. Without a manifest nothing changes.
- `JOB_WORKERS` picks the job queues a process consumes (default all; names, `prefix*`, `!` to exclude). To keep a long-running queue off the API replicas, run an extra full instance with the same `SERVICE_NAME` and `JOB_WORKERS=<queues>`, and give the replicas `JOB_WORKERS=!<queues>`. Processes sharing a `SERVICE_NAME` load the same modules, every queue needs a consumer somewhere, and a handler never assumes it runs where its job was enqueued.
- The shipped Redis Streams and BullMQ drivers do not honor `orderingKey`; use an overlay when strict ordering is required.
- `REALTIME_TRANSPORT` is Redis Pub/Sub (`RedisPubSubRealtimeTransport`, auto-bound on `REDIS_URL`, no in-process fallback - ADR-0031) - fire-and-forget UI push, not a durable event: a message published while nobody is subscribed is simply lost, which is why a realtime channel carries a change _signal_ the client refetches, never the state itself. Channels, signals, presence and the revocation channel are prefixed with `REALTIME_NAMESPACE`, which defaults to `SERVICE_NAME`. The two are opposite requirements: `SERVICE_NAME` must differ per service (consumer group), `REALTIME_NAMESPACE` must match across the services that push to the same clients, and must differ between deployments sharing one Redis. A service that sets `SERVICE_MANIFEST` must set both, or the boot fails. A manifest entry takes one flag, `id:no-routes`: the module still binds its ports, handles its events and runs its jobs, but its router is discarded, so it serves no HTTP route. Its router factory still runs, because several modules construct the service their events and jobs read, or schedule their jobs, inside it (the audit writer assigns `svcRef` there); a factory that guards the HTTP surface takes `options.mounted` and skips that guard when it is `false`. Use it for a module a kept module `dependsOn` but whose surface the service must not expose (identity's sign-in, whose country gate lives in the compliance module). A manifest that names identity must name audit too, since identity `dependsOn` it, or the boot fails on the missing dependency. An unknown flag, or the flag on an infra overlay or an unknown id, fails the boot. `RealtimePresence`/`getOnlineUserIds` are shared across replicas via `RedisPresenceStore`, a per-channel sorted set scored by each member's last heartbeat and read with a TTL cutoff, so a crashed replica's members self-expire instead of lingering forever.
- Chat and social read identity data through the `ACCOUNT_READER` port, never by joining identity or profile tables. Identity binds the same-database reader, live on every read. Chat on a database of its own sets `IDENTITY_SERVICE_URL` (the identity service's private origin), `IDENTITY_SERVICE_NAME` (its `SERVICE_NAME`, default `monolith`) and `INTERNAL_API_SECRETS`; it then reads over the ADR-0052 internal API with a 500ms timeout and keeps each account it asked for 30s in a per-process cache of at most 10,000 entries; concurrent cold reads of one id share one call, and a miss is never cached. Past 10,000 distinct accounts in play (a room roster or online count that large) reads go cold every time. Reads that decide a privilege or a privacy gate skip that cache (`{ fresh: true }`): every `AdminGuard` check, creating or accepting a room invite, the invite list's exclusion check, the viewer's staff check on a roster, and the closed / `allowFriendRequests` / `showOnlineStatusToFriends` reads in social. Only the chat plugin binds the remote reader, so social on a database of its own needs chat in the same process. The identity service answers only the callers named in `ACCOUNT_READER_CALLERS` (a comma list of `SERVICE_NAME`s; unset refuses every caller); this guards against misconfiguration only, because one install-wide secret signs as any caller name. A failed call fails closed: an access decision refuses, and a chat or social route answers 503 `SERVICE_UNAVAILABLE` on a timeout, network failure or 5xx (a 4xx, such as a caller missing from `ACCOUNT_READER_CALLERS` or clock skew, stays a 500); only the avatars on a history page and a message author's profile degrade. The boot fails when `IDENTITY_SERVICE_URL` is set in a process that serves identity itself (no `SERVICE_MANIFEST`, or one naming identity without `:no-routes`), and in production when it is not https unless `IDENTITY_SERVICE_ALLOW_HTTP=true` (for a service mesh that encrypts the hop inside the private network).

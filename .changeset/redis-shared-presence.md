---
'@openora/core': minor
---

**`RealtimePresence`/`getOnlineUserIds` are now shared across every replica**, closing the gap `RedisPubSubRealtimeTransport` shipped with (ADR-0031). Presence was previously an in-process `Map`, correct on a single instance and an undercount across several - a real problem for `/rain` (`chat-commands.service.ts`), which resolves the online list to decide who receives money: a multi-instance deployment reached fewer recipients than it should.

`RedisPresenceStore` (`redis-pubsub-realtime-transport.ts`) replaces it with one Redis sorted set per channel, keyed by member, scored by the epoch-ms of that member's most recent heartbeat from any connection. `join()` fires an immediate heartbeat and renews it every 15s for as long as the connection lives; reads filter to scores newer than 45s. A replica that dies without calling `leave()` simply stops renewing - its members age past the cutoff and drop out on their own, with no cleanup process required. That self-expiry is deliberate: a plain Redis SET with explicit add/remove would instead leave a crashed replica's members in the set forever, diluting every future rain payout across phantom recipients permanently. `leave()`/transport `close()` still remove immediately on the graceful path; expiry is the safety net.

`getOnlineUserIds`/`count` cost one `ZRANGEBYSCORE`/`ZCOUNT` call each - O(log N) plus O(M) for the M members returned, never a per-connection scan or a keyspace scan, regardless of how many tabs a member has open.

No consumer-facing API change: `RealtimePresence`/`getOnlineUserIds` keep their existing shape, including excluding `anonymous:*` members.

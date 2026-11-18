---
'@openora/core': minor
---

Two warn-level log signals for lag. `event outbox lagging` (`pending`, `oldestPendingAgeMs`) is logged by the outbox relay, at most once a minute, while the oldest unpublished `event_outbox` row is older than 60 seconds. `stream consumer lagging` (`stream`, `group`, `pending`) is logged by the Redis Streams broker, at most once a minute per stream and group, while a consumer group has more than 100 unacknowledged entries. `eventOutboxBacklog(db)` returns the same `{ pending, oldestPendingAgeMs }` for a health check.

---
'@openora/core': patch
---

A wallet debit read play eligibility, and the RG limit gate, rank, race, streak and challenge
accrual read exchange rates, through the root pool while holding their own transaction. Each
concurrent bet therefore needed two pool connections: once every connection was held by a
transaction waiting for a second one, the pool deadlocked and the whole API stopped answering.

`PLAY_ELIGIBILITY.isRestricted` and `EXCHANGE_RATE_READER.getRate`/`convert` now take an
optional trailing `tx`, and every in-transaction caller in core passes its own. A rate read on
a caller's transaction skips the shared in-flight dedup, and a provider quote is persisted in
the background instead of on the caller's request. Overlays that call either port inside a
transaction should pass their `tx` the same way.

The pool is now sized by `DATABASE_POOL_MAX` (default 10) and waits at most
`DATABASE_POOL_ACQUIRE_TIMEOUT_MS` (default 5000) for a free connection, so an exhausted pool
fails the waiting query instead of hanging it forever.

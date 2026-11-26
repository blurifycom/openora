# ADR-0066: Ledger projections write block-first and carry a heartbeat

**Date**: 2026-11-25
**Status**: Accepted. Extends [ADR-0056](./0056-ledger-owned-play-eligibility-projection.md) and [ADR-0057](./0057-ledger-owned-limits-projection.md) for a writer in another service.

## Context

ADR-0056 and ADR-0057 write the ledger's eligibility and limits copies in the owner's transaction.
Once identity and compliance run beside a money service on its own database, that write becomes a
remote call: it cannot roll back with the owner's transaction, and a stalled owner leaves the copy
silently old.

## Decision

**Block-first.** A restricting change (RG block, self-exclusion, ban, status change, a new or lower
limit) writes the projection before its own commit, so a write that fails fails the change. A
loosening (a playable eligibility state, a confirmed limit raise or removal) on a remote projection
skips the write, commits first and reaches the ledger by its outbox event through `reconcile`. A
local projection keeps writing every change in the transaction. Ports: `remote?: boolean` on
`PLAY_ELIGIBILITY_PROJECTION` and `RG_LIMIT_LEDGER`, set by the remote binding;
`RgLimitsPublisher.publish(tx, userId, { loosening })`.

**Heartbeat.** The owner (identity, compliance) calls the projection port's `heartbeat()` every
`LEDGER_PROJECTION_HEARTBEAT_MS` (default 10000) from one recurring job
(`identity-ledger-heartbeat`, `compliance-ledger-heartbeat`) scheduled only where its module is
selected (`mounted`), so one replica beats per tick. The job is scheduled only when the projection
is remote or `MONEY_PORTS_CALLERS` is set in that process, since nothing reads the beat otherwise,
and the owner beats once at boot before the first tick. A stalled job queue therefore also refuses
stakes once the beat is stale.
The ledger stores it in `ledger_projection_heartbeat` at its own clock. When another service may write the
projections, which the money service reads from its own `MONEY_PORTS_CALLERS` being set (ADR-0067),
a stake (eligibility) and a deposit or wager (limits) refuse with `LedgerProjectionStaleError`
(`ledger_projection_stale`: 503 on the deposit and casino start-round routes, a `ledger_unavailable`
refusal on the Ledger API, which is not stored on the idempotency key so a retry after recovery is
decided again, and a `player_blocked` refusal on the sportsbook ledger) once the last beat is older than
`LEDGER_PROJECTION_STALE_MS` (default 60000), or missing. Without `MONEY_PORTS_CALLERS` nothing is checked;
with it set the check runs even for a writer in the same process. The eligibility row is read before the age: a player it already blocks is refused as blocked, and stored, however old the beat, so a stale beat never turns a block into a retryable answer. The age is read at the database
clock, and so are a cooling-off end and a limit window, so a replica clock that drifts never moves a
refusal. Once the beat is older than `LEDGER_PROJECTION_ALERT_MS` (default 30000) a check logs an
error the error tracker receives, at most once per that interval per projection, so a stalled owner
is seen before stakes refuse.

**Rollout order.** A missing beat refuses, and a remote owner's beat is itself a money-ports call,
which the money service answers only once `MONEY_PORTS_CALLERS` names the owner's service. So set
`MONEY_PORTS_CALLERS` on the money service first, then deploy identity and compliance with
`MONEY_SERVICE_URL`: each beats once at boot, so a row per projection lands within seconds. Confirm a
row per projection in `ledger_projection_heartbeat` younger than `LEDGER_PROJECTION_STALE_MS` before
routing stakes to the money service; until then every stake, deposit and wager it decides refuses. A
missing row never passes: it is indistinguishable from an owner that never started. A process that
loads the money modules locally on the database a money service also serves sets
`MONEY_PORTS_CALLERS` too, so its owners beat for the money service that checks them.

**Limit writes.** `reconcile` takes the slot locks of the limits it writes before the version row,
the same locks a deposit or wager check takes. `writeFromRemote` runs while compliance's own
transaction still holds the slot lock of the limit it changes, and on the supported shared database
the same advisory lock cannot be taken from a second connection, so it takes a per-player
projection lock instead, which a check takes after its slot locks. A lowered limit therefore waits
for an in-flight check and the next check reads it, and the write never waits on its caller. A
player's first limit is not serialized this way: with no limit rows yet, a check returns before it
takes any lock, so an in-flight check can pass while the first limit commits, and only the next
check reads it.

**Deposits.** The eligibility gate of a player deposit and of an on-ramp checkout runs inside the
transaction that reserves it, under the player's deposit lock and after the replay lookup, reading
the projection `FOR SHARE` like a stake, so a block that commits meanwhile is seen or waits, and a
retried deposit that already completed returns its result. The lock order is deposit lock, then
eligibility row. The operator's deposit admission policy runs before that transaction, as it may
read over its own connection or a remote port.

**Drift.** The wallet reconciliation cycle (hourly by default) already compares each projection with
its owner, repairs through `reconcile` or the owner's `repair`, and files `play_eligibility_drift` /
`rg_limits_drift` findings; it now also logs each new drift at error level.

## Consequences

- A restriction rolled back after a remote write leaves the ledger stricter until the drift repair.
- A lift on a remote projection is visible to stakes only after its event is delivered.
- Thresholds need compliance sign-off before production.
- A late loosening event surfaces through the reconciliation cycle's existing `outbox_relay_lag`,
  `event_dead_letters` and drift `behind` findings; no separate lag check is added, as a late
  loosening only keeps the ledger stricter.

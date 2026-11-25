# ADR-0062: Ledger projections write block-first and carry a heartbeat

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
selected (`mounted`), so one replica beats per tick. A stalled job queue therefore also refuses
stakes once the beat is stale.
The ledger stores it in `ledger_projection_heartbeat` at its own clock. When another service may write the
projections, which the money service reads from its own `MONEY_PORTS_CALLERS` being set (ADR-0063),
a stake (eligibility) and a deposit or wager (limits) refuse with `LedgerProjectionStaleError`
(`ledger_projection_stale`: 503 on the deposit and casino start-round routes, a `player_blocked`
refusal on the Ledger API and the sportsbook ledger) once the last beat is older than
`LEDGER_PROJECTION_STALE_MS` (default 60000), or missing. A local writer is never checked.

**Drift.** The wallet reconciliation cycle (hourly by default) already compares each projection with
its owner, repairs through `reconcile` or the owner's `repair`, and files `play_eligibility_drift` /
`rg_limits_drift` findings; it now also logs each new drift at error level.

## Consequences

- A restriction rolled back after a remote write leaves the ledger stricter until the drift repair.
- A lift on a remote projection is visible to stakes only after its event is delivered.
- Thresholds need compliance sign-off before production.

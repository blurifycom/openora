# ADR-0055: Ledger-owned limits projection

**Date**: 2026-11-13
**Status**: Accepted. Supersedes in part [ADR-0036](./0036-rg-limit-enforcement-and-cooldown.md): compliance no longer binds `RG_LIMITS`, and the gate no longer reads `user_limit`.

## Context

ADR-0036 made deposit and wager limits binding through `RG_LIMITS`, which compliance bound to a
gate over its own `user_limit` table and the wallet's transactions. Every bet and deposit therefore
read a compliance table inside the wallet's transaction, the wallet could not take a stake without
compliance in the same process, and a split service that loaded the wallet had to load compliance
too. ADR-0054 moved the play eligibility gate into the ledger for the same reasons; this does the
same for limits.

## Decision

**The wallet owns `ledger_user_limit` and `ledger_user_limit_version`, and binds `RG_LIMITS`.**
The gate reads only these tables and the wallet's own `wallet_transaction` spend. It takes the
`limitSlotKey` advisory lock of every slot it checks before re-reading the limits, as before. A
limit with no rate into its currency, or with no currency at all, refuses (fails closed). The
deposit check stays a check before the PSP call. `RG_LIMITS` and `RG_LIMIT_LEDGER` are sealed.

**Compliance writes the projection in its own transaction.** Every limit writer (player
self-service, the admin override, the cool-down confirm and expiry, a currency change on the
profile) calls `RG_LIMITS_PUBLISHER.publish(tx, userId)` after its change. The publisher bumps
`rg_limit_version` (the per-user version compliance owns), reads the effective limits, writes them
through `RG_LIMIT_LEDGER.write(snapshot, tx)` and emits `compliance.rg_limits.changed` in the same
transaction. The limit change and the projection commit or roll back together, and a failed
projection write fails the change.

**`user_limit.amount` is always the limit in force.** A raise waits in `pending*` until its
cool-down ends and the player confirms (ADR-0036), so a decrease reaches the ledger at once and an
increase only on confirmation.

**Replays and repairs never loosen.** The event handler and the backfill call `reconcile`, which
writes only a missing row, an older one, or a same-version row whose limits differ. Compliance
holds the version row lock when it writes, so its version is the truth: a held version ahead of it
came from outside compliance, is overwritten, and is logged as an error.

**Lock order.** A profile currency change locks the player row, then the version row, then the
ledger rows. A compliance writer takes the slot lock, then `user_limit`, then the version row, then
the ledger rows. A stake locks the wallet row, then the slot lock. Writers never lock the wallet
row, so no cycle exists.

**A limit the ledger has not seen must not be bypassable.** Three layers:

1. The wallet migration that ships the gate seeds `ledger_user_limit` from `user_limit` (version 0
   for every user), so every limit set before the deploy is enforced from the first request.
2. Compliance runs `backfillRgLimits` (`@openora/core/compliance/seed`) at boot, in keyset batches
   of read-only snapshots, and the seed scripts run it after direct writes.
3. Each `rg-monitor` tick re-projects the users whose limits changed in the last ten minutes. A
   replica from before this ADR, still serving during the rolling deploy, writes limits without
   publishing; the tick projects them within a minute instead of at the next boot.

The alternative, refusing every stake of a user whose projection is missing, was rejected: the
gate cannot tell "no limit" from "not projected yet" without reading a compliance table, which is
what this ADR removes.

**Boundaries.** The wallet imports no compliance or profile schema. Compliance declares
`RG_LIMIT_LEDGER` in `requiresPorts`. The profile declares `RG_LIMITS_PUBLISHER` in
`controlPorts` with `boundBy: 'compliance'`. Gaming and the wallet no longer declare `RG_LIMITS`
as a control port: the wallet binds it.

## Consequences

- A lowered limit binds the next stake the moment it commits; a rolled-back one never did.
- The wallet can take stakes in a process without compliance. A split service that loads the
  wallet no longer has to load compliance for limits.
- A removed limit written by an unpublishing writer stays projected (stricter) until the next full
  backfill at boot. A direct SQL change to `user_limit` reaches the ledger within one `rg-monitor`
  tick if it moves `updated_at`, and at the next boot otherwise; such a script should run
  `backfillRgLimits` itself.
- Loss limits stay unenforced and are computed from the wallet ledger through
  `RG_LIMIT_LEDGER.spendFor` (ADR-0046).
- The projection holds the user id, limit type, period, amount and currency. No personal data.

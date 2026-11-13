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
self-service, the admin override, the cool-down confirm and expiry) calls
`RgLimitsPublisher.publish(tx, userId)` after its change. The publisher bumps `rg_limit_version`
(the per-user version compliance owns), reads the effective limits, writes them through
`RG_LIMIT_LEDGER.write(snapshot, tx)` and emits `compliance.rg_limits.changed` in the same
transaction. The limit change and the projection commit or roll back together, and a failed
projection write fails the change. A row the snapshot contract rejects (a currency or amount
written around the API) is projected with no currency, so it refuses every move it gates and never
blocks the write of a player lowering another limit.

**Every money limit carries its currency.** The writers' input schemas require one. A limit from
before compliance migration 0005 had none and was resolved to the player's currency the first time
something touched it, so a currency change could re-denominate an untouched one. Compliance
migration 0017 pins them all to the player's current currency, keeping `updated_at`; the projection
then never depends on the player's currency, and nothing outside compliance publishes. A row whose
player is gone, or whose slot already holds that currency, stays without one and is enforced
fail-closed: 0017 counts these rows in a `NOTICE` and every boot backfill logs a warning with their
count. A player change to such a row is refused with `CONFLICT`; the admin override is the fix and
replaces it in the override's currency, audited and published like any override. The repair stays
reduce-only: the row's amount is read in the player's current currency, the one 0017 would have
pinned, and checked like any override, so a raise or a missing rate is refused. With no player
record left, the repair may only set a zero limit. A slot read puts
the NULL row first, so with a pinned twin beside it the outcome does not depend on the planner.

**`user_limit.amount` is always the limit in force.** A raise waits in `pending*` until its
cool-down ends and the player confirms (ADR-0036), so a decrease reaches the ledger at once and an
increase only on confirmation.

**Replays and repairs never loosen.** The event handler calls `reconcile`, which writes only a
missing projection or a strictly older one, never an equal version. The backfill compares instead:
`RG_LIMIT_LEDGER.drifted` returns the users whose projection is missing, at another version, or at
the same version with other rows, and compliance re-publishes each in its own short transaction, so
a repair always lands under a new version and a late delivery of the old one is ignored. This is
where it departs from ADR-0054, whose backfill reconciles at an equal version: a writer that skips
the publisher changes the limits without bumping the version, so an event still in the outbox
carries other rows at that same version, and an equal-version write would let it undo the repair.
Compliance holds the version row lock when it writes, so its version is the truth: a held version
ahead of it came from outside compliance. `write` overwrites it with compliance's next version and
logs an error. It does not move compliance past the held one: a foreign write at the top of the
integer range would make that bump overflow and fail every later change of the player's limits.
No outbox event carries a version above compliance's, so nothing older can land after the repair.

**Lock order.** A compliance writer takes the slot lock, then `user_limit`, then the version row,
then the ledger rows. A backfill repair takes the version row, then the ledger rows. A stake locks
the wallet row, then the slot lock. Writers never lock the wallet row, so no cycle exists.

**A limit the ledger has not seen must not be bypassable.** Three layers:

1. The wallet migration that ships the gate (0047) seeds `ledger_user_limit` from `user_limit`
   (version 0 for every user), so every limit set before the deploy is enforced from the first
   request. Compliance migration 0017 gives every user with a limit a version 0 row, so the two
   agree and the boot backfill finds nothing to repair.
2. Compliance runs `backfillRgLimits` (`@openora/core/compliance/seed`) at boot. It walks
   `rg_limit_version` by its key in batches of read-only snapshots, after giving a version row to
   any user with a limit and none, and the seed scripts run it after direct writes. Only this full
   pass repairs a user whose limits were all deleted: the heal below finds users by a changed row,
   and a deleted row leaves none.
3. Each `rg-monitor` tick first re-projects the users whose limits changed in the last ten minutes
   (read off `user_limit_updated_at_idx`), in its own error boundary. A replica from before this
   ADR, still serving during the rolling deploy, writes limits without publishing; the tick
   projects them within a minute instead of at the next boot.

**A missing projection fails open.** The gate cannot tell "no limit" from "not projected yet"
without reading a compliance table, which is what this ADR removes, so a user with no projected
rows is not limited. The window is bounded. During the rolling deploy, a limit an old replica
writes is unprojected until the next `rg-monitor` tick on a worker running this code: one tick, a
minute. After a rollback and a roll-forward, every limit changed while the old code ran is stale
until the boot backfill finishes; the heal covers the last ten minutes of them on the first tick.

**The 0047 seed reads compliance's tables once.** It is the only place the wallet reads
`user_limit` or `player`: a one-time bridge in the migration that ships the gate, guarded by
`to_regclass` and run through `EXECUTE` so it plans only when the tables exist. Modules migrate in
name order, so compliance (0017 pins the currencies and seeds the versions) runs before the wallet.
If the wallet migrates first, or without compliance, the seed copies the limits as they are (with
the player's currency for an unpinned one, the value 0017 then writes) or, with no `user_limit`, is
a no-op and the boot backfill projects every limit.

**Boundaries.** The wallet imports no compliance or profile schema. Compliance declares
`RG_LIMIT_LEDGER` in `requiresPorts`. Gaming and the wallet no longer declare `RG_LIMITS` as a
control port: the wallet binds it.

## Consequences

- A lowered limit binds the next stake the moment it commits; a rolled-back one never did.
- The wallet can take stakes in a process without compliance. A split service that loads the
  wallet no longer has to load compliance for limits.
- A removed limit written by an unpublishing writer stays projected (stricter) until the next full
  backfill at boot. A direct SQL change to `user_limit` reaches the ledger within one `rg-monitor`
  tick if it moves `updated_at`, and at the next boot otherwise, so a lowering made that way is
  unenforced until then; such a script must run `backfillRgLimits` itself.
- A process without exchange rates refuses every cross-currency move of a player with a limit.
- Loss limits stay unenforced and are computed from the wallet ledger through
  `RG_LIMIT_LEDGER.spendFor` (ADR-0046).
- The projection holds the user id, limit type, period, amount and currency. No personal data.

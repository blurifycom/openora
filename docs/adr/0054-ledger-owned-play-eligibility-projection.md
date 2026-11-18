# ADR-0054: Ledger-owned play eligibility projection

**Date**: 2026-11-13
**Status**: Accepted. Supersedes in part [ADR-0032](./0032-rg-enforcement-at-wager-time.md): a stake no longer reads `PLAY_ELIGIBILITY` and the identity `user` row.

## Context

ADR-0032 put the responsible-gambling gate on the money boundary: a `bet` debit and a sportsbook
stake read `PLAY_ELIGIBILITY`, which identity binds to a `FOR SHARE` read of its own `user` row.
That made every stake depend on identity at runtime and put the identity row lock inside the
wallet's transaction. Once the ledger serves stakes from its own API (the Ledger API v1), that
coupling blocks running the ledger without identity in the same process, and it makes the ledger's
refusal depend on a table it does not own.

A first attempt pushed the state over the Ledger API (`setPlayEligibility`) before identity's
commit, with a stricter-of merge and an after-commit apply for lifts. Review found three problems:
a restriction that rolled back still left the ledger stricter than identity; the version lived on
a public port, so any caller could push a high version and freeze a player's state; and the
lift-after-commit window raced the RG sweep.

## Decision

**The wallet owns `ledger_play_eligibility`.** A stake reads only this table, through
`LEDGER_PLAY_ELIGIBILITY`, `FOR SHARE` in the stake's transaction. A user without a row is refused.

**Identity writes it in its own transaction.** Every change to an input (RG block, `isActive`,
ban, player status) bumps `user.play_eligibility_version` and calls
`PLAY_ELIGIBILITY_PROJECTION.write(snapshot, tx)` on the caller's transaction, then emits
`identity.play_eligibility.changed` in the same transaction. The ledger row and the identity row
commit or roll back together. `LOGIN_ENFORCEMENT.block`/`unblock` and
`USER_COMMANDS.publishPlayEligibility` take the caller's transaction for this reason. Registration
publishes in the transaction that creates the player row.

**The port is internal, not on the Ledger API.** `PLAY_ELIGIBILITY_PROJECTION` is bound by the
wallet and declared in identity's `controlPorts` with `boundBy: 'wallet'`, so a split that loads
the wallet but leaves the port unbound refuses to boot. Without the wallet, identity only emits the
event. Identity holds the user row lock when it writes, so its version is the truth: a held version
ahead of it came from outside identity, is overwritten, and is logged as an error.

**Replays and repairs never regress.** The event handler and the backfill call `reconcile`, which
writes only a missing row, an older one, or a same-version row whose state differs. Identity owns
`backfillPlayEligibility` (`@openora/core/pam/identity/seed`), runs it at boot in keyset batches
of short transactions, and the seed scripts run it after direct writes. The wallet imports no
identity or profile schema.

**RG changes for one player serialise.** Activate, lift and the expiry sweep each take
`rg:exclusion:<userId>` as a transaction advisory lock before reading the exclusions they
recompute from, so a lift or sweep cannot clear a block a concurrent self-exclusion is about to
commit.

## Consequences

- A restriction is visible to a stake the moment it commits, and a rolled-back one never was.
- A stake waits on a concurrent restriction's row lock, not on identity: lock order is user row,
  then ledger row for identity, and ledger row, then wallet rows for a stake.
- ADR-0032's "gaming and wallet declare `requiresPorts: [PLAY_ELIGIBILITY]`" no longer holds for
  stakes. Deposits, payouts, game launch and sportsbook session issue still read
  `PLAY_ELIGIBILITY`, and ADR-0032's enforcement points and fail-closed rule stand.
- A script that writes the identity or player status columns directly leaves the ledger behind
  until the next boot; it must run `backfillPlayEligibility` itself.
- The ledger holds one row per user. It carries no personal data beyond the user id and
  restriction flags.

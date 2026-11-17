# ADR-0060: Bonus grant concurrency and sequential rollover attribution

**Date**: 2026-11-17
**Status**: Proposed
**Relates to**: ADR-0017 (command-port idiom), ADR-0052 (rank periodic bonus on the house edge).

## Context

A player could hold several active grants, but a bet scored only the oldest: the others'
rollovers sat still, and a bonus-funded stake could count against a grant whose funds never paid
it. Operators also want to cap how many bonuses run at once.

## Decision

**`promo.bonus.grantConcurrency` sets the limit, per currency.**

- `single` allows one active grant.
- `per_source` allows one per grant source.
- `multiple` (the default, and the behaviour before this change) allows any number.

The slot is checked under an advisory lock on (player, currency).

**A grant over the limit is created `pending`.** It is not wagered against until the player
activates it through `POST /promo/grants/{id}/activate`. Its claim window is `expiryDays` from
creation; the expiry sweep closes it after that. Activation restarts the rollover window
(`expiresAt` = now + `expiryDays`), sets `activatedAt`, is audited, and emits
`promo.bonus.activated`. A busy slot answers `409 BONUS_SLOT_TAKEN`, and a grant that is
not pending or is past its window answers `409 BONUS_NOT_ACTIVATABLE`.

**A deposit bonus is refused up front, not queued.**

- Opting in to a one-off deposit offer while the slot is taken answers `409 BONUS_SLOT_TAKEN`.
- A deposit that lands after another bonus took the slot pays no bonus. The deposit is still
  recorded against the claim, so a redelivery cannot pay it later, and the claim stays open for
  the next deposit.
- Other sources still queue as pending: the player does not choose when they arrive.

**A bet is attributed across every active grant in rollover order**, earliest expiry first.

1. The bonus part of the stake is drawn from the grants in that order, skipping a grant whose terms
   exclude the product. Each grant's bonus-funded share progresses that grant only.
2. The real-funded part fills the requirements in turn, each weighted by that grant's own
   contribution percent.
3. When a grant fills, it takes only the stake needed to fill it. The rest carries to the next
   grant and is weighted afresh, so no stake counts twice.
4. Real stake that no requirement absorbs stays on the first grant with no progress, so a later win
   or void still finds the whole stake on the round.

Each touched grant gets its own stake entry, so settlement splits a win or void back across them.
One bet can complete several grants: the wallet converts each, and gaming emits one
`promo.bonus.completed` per grant.

Max bet is the strictest `maxBet` among the active grants.

**`promo.ranks.progressBasis` decides what moves rank progress.** `total` (the default) counts the
whole eligible stake, as before. `real` counts only the own-money part, toward both lifetime and
period wagered. The house-edge margin is unchanged.

## Consequences

- `BonusWagerOutcome.completed` and `WalletDebitOutcome.completed` change from one object to an
  array. This breaks the port contract. All in-repo callers are updated; an out-of-tree consumer
  reading the old shape must update too.
- `BonusGrantArgs` gains `onSlotTaken` (`pending` | `refuse`), and the grant outcome may now report
  `status` and the failure reason `slot_taken`.
- `PlayerGrant` exposes `activatedAt`. The bonus ledger view shows a pending grant as pending, and
  one that expired without ever being activated as cancelled.
- No migration: `pending` and `activatedAt` already exist.
- A bet locks every active grant in its currency, in a fixed order (expiry, creation, id).
- Attribution works on the real-versus-bonus split the wallet reports today. A finer per-bucket
  split can feed the same function later without changing its rules.

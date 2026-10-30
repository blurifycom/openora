# ADR-0046: Claimable rakeback on the house edge

**Date**: 2026-10-28
**Status**: Accepted

## Context

Rank rakeback paid a percentage of every qualifying own-money stake, credited with the bet. Two
operator needs fall outside that shape.

The first is paying on the house edge. A percentage of the stake costs the same on a 99% RTP game
as on a 90% one, so rakeback becomes a loss on low-edge games. Paying on the edge needs the
game's RTP on the bet, and the wagering seam did not carry it.

The second is letting the player collect rakeback when they choose, which makes it a balance the
platform holds. That needs a ledger of what is owed, a payout that cannot pay twice, and answers
for a round rolled back after the money moved and for a player who can no longer claim.

## Decision

**Two config switches, defaulting to today.** `promo.rakeback.basis` (`stake` | `margin`) and
`promo.rakeback.payout` (`instant` | `claim`) live in platform config, not on the rank-config row.
They change what the platform owes, so they ship with a deploy rather than a backoffice edit.

**RTP rides on `WagerContext` and lands on the ledger.** An optional `rtp` decimal fraction is set
by whoever reports the bet, and the wallet records it with the product on the bet's row.
`houseEdge(realAmount, rtp)` in `@openora/core/server` is the one pricing rule: a missing or zero
rtp, or one above 1 such as a percent, prices at zero rather than a guess. The margin basis pays
`houseEdge × (tier + boost) / 100`.

**Accrual rows are the ledger.** In claim mode each bet writes a `promo_rakeback_accrual` row with
the stake, rate, boost and rtp that priced it. The rows are the single source of the unclaimed
balance and the admin liability.

**A claim is one transaction with two guards.** A `(userId, idempotencyKey)` claim row replays a
retry. Rows flip from `accrued` to `claimed` only if they still are, after the credits, so a
racing second claim finds fewer rows than it credited and rolls back. The flip takes the row
locks, not a `FOR UPDATE` read, because a rollback locks the balance first. Each currency is
one `cashback` credit whose provider ref is the claim id and currency, so the wallet's unique
guard backs it. The minimum is checked on the total priced into the wallet reference currency.
A currency with no rate counts nothing toward it but is still paid.

**A rollback never reduces paid rakeback.** It walks the round's rows newest first. A claimed
or voided row keeps what priced it and records its share in `rolledBackStake`, so no share is
absorbed twice, and the rest reduces or reverses unclaimed rows.

**Responsible gambling decides who may claim.** A claim is refused under an RG block, a
self-exclusion, or a suspended or closed account. A self-excluded or closed account can never
claim, so its balance is paid automatically on the event, ignoring the minimum, with a daily
sweep for a missed event. A cooling-off keeps the balance for later. The reminder skips anyone a
claim would refuse.

**Admins void, they do not edit.** A void needs a reason, applies only to an unclaimed row, and
is audited in its transaction, as are a claim and an automatic payout.

## Consequences

- Margin rakeback depends on the provider reporting `rtp`. A provider that does not earns its
  players nothing under that basis.
- Claim mode adds a liability the operator reconciles from the liability view.
- The claim id is on the admin wallet transaction only. The player's history is unchanged.
- Paid rakeback is final for every automated path.
- Switching `payout` back to `instant` leaves accrued rows claimable through the same route until
  they are drained.

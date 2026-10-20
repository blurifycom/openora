# ADR-0047: Sportsbook Provider Promotions

**Date**: 2026-10-16
**Status**: Accepted

## Context

A turnkey sportsbook provider runs its own promotions (freebets, free money, no-risk bets, payout
boosts) and tells the wallet on its callbacks that a bet used one. The ledger port of ADR-0046 knows
only cash bets: a reserve debits the full stake, a void returns it, and a loss pays nothing. A
promotion bet breaks each rule. Promotion types differ per provider, and the wallet ledger feeds
GGR, RG spend, wager tracking and debt.

## Decision

- **The provider owns the promotion; core owns the money facts.** At reserve the overlay declares
  who paid the stake: the promotion (and whether a void returns it) or the player (and whether a
  loss is refunded), plus an opaque type label. Core resolves that into a cash stake, a void payout
  and a maximum loss refund on the bet and holds every later step to them. Core keeps no list of
  promotion types. An unknown or contradictory declaration is refused, never stripped.
- **No split funding.** A stake is paid wholly by the player or wholly by the promotion, never in
  part by a bonus grant. Bonus-funded stakes need their own ADR.
- **A cash-only ledger.** The wallet records only cash that moves, with the existing types. A
  promotion-paid stake writes no debit, every promotion payout is a `win`, and a void credits
  `bet_reversal` only when cash was staked. Crediting payouts as `bonus` was rejected: bonus-cost
  analytics, the debt paths and net deposits would each need changing for what the bet row already
  reports.
- **Attribution lives on the bet.** A settle may carry the part of the payout a promotion funded.
  Core stores it, zeroes it on reopen, and an admin report sums it from the append-only transaction
  rows by type, funder and currency. The funder is config, copied onto the bet at reserve.
- **Operators opt in.** Promotions are off by default. One cap in USD limits a promotion-paid stake,
  priced with the exchange-rate reader before the reserve transaction; a missing rate refuses. A
  per-currency cap would have to track each coin's price by hand.
- **A promotion-paid stake is not player spend.** It counts toward no wager limit, rank, streak or
  race, and its payout never reduces measured loss. Debt it leaves is taken back in its own round.
- **Old overlays are unchanged.** New fields join the request fingerprint only when present, so a
  retry across the deploy keeps its fingerprint.
- **The player summary reads bet rows, not the ledger.** GGR is cash stake minus payout, the payout
  taken at each bet's latest settlement. For a bet accepted and never reopened the two agree.
  Matching the ledger for a reopened bet would mean tracing which part of each shortfall was
  offset, collected or written off, and when; the debt list shows what is owed.

## Consequences

- An operator maps each provider promotion to one declaration in its overlay. Ledger readers stay
  unchanged and correct on a cash basis.
- The platform bonus cost excludes sportsbook promotions; the promotion report is their source.
  Shared GGR totals have no product split, so promotion wins lower them.
- A promotion win is withdrawable real money with no deposit behind it. The promotion report and the
  withdrawal review are the AML control.
- An older core strips the declaration and debits a freebet's stake, so an overlay pins its core
  version and refuses a promotion type it does not map.
- Freebets granted by core's bonus engine are deferred.

# ADR-0040: Bonus funds live on the grant, not in the wallet balance

**Date**: 2026-09-18
**Status**: Accepted

## Context

The platform needs a bonus a player must wager before they can withdraw it. Two shapes were
available.

The first is the one already shipped for chat gifts and rain: the bonus is credited into
`wallet_balance` like any other money, a `wallet_bonus_credit` row records how much of it is still
un-wagered, and `debitWithdrawableBalance` subtracts a proportional locked share at withdrawal
time. One balance, one number the player sees, and a formula standing between them and their own
cash.

The second keeps bonus funds out of the wallet entirely. A grant row carries its own balance, a
bet decides which side pays, and the money becomes real exactly once - when the wagering
requirement is met.

The specification asks for the second: bonus balance tracked separately from real balance, bets
drawing on both, and a forfeit that takes the bonus together with any winnings it produced. The
last clause is the one that decides it. Winnings from a bonus-funded stake have to be
attributable to the grant, and under one fungible balance there is nothing to attribute them to.

## Decision

`promo_grant.bonus_balance` is the bonus balance. Bonus funds never enter `wallet_balance` until
they convert, and conversion writes one `wallet_transaction` of type `bonus` for the exact amount.

`wallet_transaction` stays the real-money ledger and still records every bet and every win for
the full amount. `promo_grant_entry` is a second, append-only ledger recording which part of each
movement was bonus. Neither is bypassed and neither is a subset of the other.

## Consequences

Withdrawal needs no bonus logic at all. The proportional locked-share subquery inside
`debitWithdrawableBalance` exists only because the old model mixed the two kinds of money in one
row; with them separated, `amount >= requested` is a complete guard. Responsible-gambling limits
are unaffected: they read `wallet_transaction`, which still sees the full stake.

Reconciliation stays correct. It compares internal balances against on-chain custody, and bonus
money was never deposited. Holding it in `wallet_balance` would manufacture a permanent
unexplained surplus on every run.

Thirty-odd existing reads of `wallet_balance` - reconciliation, the custody sweep, swap, deposit,
withdrawal, the balance stream, admin reporting - keep their current meaning. The alternative, a
`kind` discriminator column, would have required a `kind = 'real'` predicate in every one of them,
and the one that got missed would be a player withdrawing bonus money.

The cost is that "total balance" is two reads rather than one: the wallet balance plus the
player's active grants. The client sums them.

The fungible model is removed rather than kept alongside. Two mechanisms implementing one product
rule means two answers to "what is locked" and a debit path with two bonus branches, which is a
bug waiting for whoever consolidates them. Chat gifts and rain move onto grants, which changes
their behaviour: that money now has to be wagered before it converts, instead of being spendable
immediately with a share locked at withdrawal.

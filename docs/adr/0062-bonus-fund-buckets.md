# ADR-0062: Bonus fund buckets

**Date**: 2026-11-17
**Status**: Accepted

> **Update (2026-11-17)**: Locking linked funds against withdrawal, deferred in the Consequences below, is now in [ADR-0064](./0064-bonus-withdrawal-locks.md). A withdrawal follows `promo.bonus.withdrawalWhileActive`: it forfeits every live grant by default, or is refused over locked money.

## Context

A deposit bonus held one number: the bonus balance. The wallet paid a bet from real money first
and drew the shortfall from bonus funds. That cannot express what deposit-match terms need: which
real money the bonus was matched against, which real money arrived alongside it, and what a win
on a mixed stake owes to each. Completion and conversion ran on the bet that crossed the
requirement, before that bet settled, so a win could land on a grant that had already converted.
The grant was also created by an async job after the deposit committed, so a crash between the
two could leave a deposit without its bonus.

## Decision

**Three buckets per grant.** C is the bonus balance (`promo_grant.bonus_balance`). B
(`linked_cash`) is the real money the bonus was matched against, A (`unlinked_cash`) the other
real money tied to the grant. A and B are counters over the real wallet balance, not separate
money: the wallet balance stays the single source of real funds. Whenever the engine reads them
it clamps them to the real balance, taking a shortfall off A before B.

**Grant math.** For a deposit D at match m with cap: C = min(D x m, cap), B = min(D, C / m),
A = D - B, each rounded down to the currency precision. Offer terms carry `funds`:
`rolloverBase` (`bonus` or `bonus_plus_linked`), `existingBalance` (`free`, or `locked`, which
makes A the whole real balance minus B), `freeFundsOrder` (`first` or `last`), a USD dust
threshold (default 0.01), and the currency's `decimals`. A deposit made while a grant runs adds
to that grant's A.

**Every stake records its split.** `wager` splits the stake across free real money, A, B and C
in the configured order and writes the split onto the stake entry. A product the grant excludes
skips C. Each attributed bet opens a `promo_grant_round` row.

**Returns are proportional.** A win, refund or rollback goes back to the buckets in the shares
the round's stakes paid, each share truncated. The rounding residue goes to the most restricted
bucket that paid (C, then B), so rounding never moves bonus money somewhere freer.

**Completion and depletion wait for open bets.** A grant whose progress reaches the requirement
completes only when it has no open round. A lost round settles through a new `closeRound` port
method, which the wallet calls on a `loss` debit. On completion, C converts to real money, B is
released, and the counters reset. A grant whose A + B + C is below the dust threshold and has
no open round becomes `depleted`, with an audit record.

**Expiry and forfeit** remove C and release A and B. An admin can forfeit any live grant. A
player can forfeit their own only where the offer terms set `allowPlayerForfeit` (off by default).

**The deposit grant is synchronous.** The wallet calls the optional `BONUS_DEPOSITS` port inside
the deposit-credit transaction, so the deposit and its grant commit together. The grant's
`sourceRef` and the per-claim deposit index make a replay idempotent. A new table,
`promo_grant_deposit`, keyed on the deposit's transaction id, stops a replay counting the same
deposit into A twice. Each deposit must meet the offer's minimum on its own; one short of it
counts toward nothing, and "first deposit only" means the first deposit that meets it. Offers require opt-in by default.

## Consequences

- One migration, `0013_bonus_fund_buckets`, adds the counters, the per-entry split, the round
  and deposit tables, and the `depleted` status.
- A round with no settling callback stays open and blocks completion and depletion. Providers
  must report losses through a `loss` debit or an end-of-round call.
- The bonus module must run in the same process as the wallet. A split deployment without
  `BONUS_DEPOSITS` credits deposits with no bonus.
- A withdrawal only clamps A and B to the remaining balance. Locking linked funds against
  withdrawal is left to a later change.
- A grant in a currency with no USD rate has a dust threshold of zero, so it depletes only at
  exactly empty.

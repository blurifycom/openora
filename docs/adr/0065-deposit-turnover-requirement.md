# ADR-0065: Deposit turnover requirement

**Date**: 2026-11-24
**Status**: Accepted

## Context

Anti-money-laundering rules in many markets require a deposit to be wagered a set number of times
before it leaves, so it cannot be layered through untouched. ADR-0064 locks only bonus money. Many
operators need none, so this is opt-in and off by default.

## Decision

**Wallet-internal, not a port.** The requirement lives in the wallet: its own tables, a
`TurnoverService`, and hooks on the credit, stake and outflow paths, all in one transaction. A
rebindable port could unlock money. Consumers reach it through the optional
`WalletCommands.addTurnoverRequirement` and `WalletReader.readTurnover`.

**The rule.** `wallet.turnover.multiplier` (default `'0'`, off). Each credit of a kind in
`creditTypes` (default `deposit`) adds `multiplier x` its pivot-currency value at credit time, one
entry per credit, deduplicated on `(source, source_ref)`. A real stake adds its pivot value times the
product percent at bet time, stamped with at most what remains unless an entry is pending; a
reversal subtracts the stamp. A product in `countAtSettle` (sportsbook by default) adds its full
stamp at settlement. The requirement is pooled across currencies and never expires. Play past it is
not banked.

**The gate.** While `remaining` exceeds `dustThreshold`, or any entry is unpriced, every withdrawal
and outbound gift, rain or donation debit is refused whole with `TurnoverLockedError`
(`turnover_requirement_unmet`, CONFLICT), after the bonus lock's `onOutflow`, so bonus-locked money
answers `bonus_funds_locked` first.

**Lock order.** Extends ADR-0064: wallet row, balance row, grants in id order, the `wallet_turnover`
row, then its entries.

**Stricter, never the sum.** Balance reads report one `locked`: the whole balance while turnover is
unmet, else the bonus lock. `bonusLocked`, the bonus lock alone, still limits a swap.

**Swaps.** A swap passes the turnover lock, since the money stays with the player; a configured
`swap_in` adds a requirement.

**Pending pricing.** A credit with no pivot rate is still credited. Its entry waits `pending` until
a cron job or a withdrawal attempt prices it, each in a transaction of its own, so a price survives a
refused withdrawal. While anything is pending the gate fails closed.

**Transfer credits.** `wallet.transferCredits` lands gift, rain and donation credits as
`bonus_grant` (default) or `cash`, a ledger credit plus a turnover entry. A cash credit locks the
recipient's wallet row, so a caller moving money between players first calls
`WalletCommands.lockWallets` with every player involved.

**Staff clear.** Staff with `turnover:clear` (compliance roles by default) zero a player's requirement
with a reason, audited and emitted as `wallet.turnover.cleared` in one transaction. A stake from
before the clear never touches a later requirement. `turnover-config:update` overrides per-product
percents for new stakes.

**Grant conversion.** The bonus module's idempotent helper turns live gift, rain and donation grants
into cash, with a requirement equal to each grant's remaining wagering. A grant that pays no cash
completes with none; one with an open round is skipped and counted. `after`/`nextCursor` page it.

## Consequences

- One wallet migration adds three tables and two nullable `wallet_transaction` columns.
- Approving a queued withdrawal skips the check.
- With multiplier `0` player reads answer `enabled: false`; staff reads still show stored data.
  Stakes, settles and reversals go unrecorded, so clear open requirements before turning it on again.
- A stake counted at settle adds its full stamp, so progress can pass the requirement until a later
  credit drops the surplus. A reversal after that credit, or of a stake counted while an entry was
  pending, can take back more than the stake still counts for.
- The grant conversion converts queued grants too, even for a player who could not have activated
  one.
- The requirement binds a restricted or self-excluded player too, until staff clear it.
- A priced entry keeps its rate, so a later rate change does not move it.
- The staff-clear cut-off is by timestamp: a reversal whose transaction opened before a clear that
  committed first subtracts nothing, even for a stake placed after it, within the reversal's own wait
  for the wallet lock.
- A stake is never an outflow, so a product where one player's stake becomes another's win is outside
  this lock and needs another control.
- An older instance applies no gate: enable the multiplier only once every instance runs this release.

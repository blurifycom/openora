# ADR-0065: Deposit turnover requirement

**Date**: 2026-11-24
**Status**: Accepted

## Context

Anti-money-laundering rules in many markets require a deposit to be wagered a set number of times
before it leaves. Without it a player can deposit, place nothing, and withdraw or gift the
money, layering funds through the operator. ADR-0064 locks only bonus
money. Many operators need none, so it is generic, opt-in and off by default.

## Decision

**Wallet-internal, not a port.** The requirement lives in the wallet: its own tables, a
`TurnoverService`, and hooks on the credit, stake and outflow paths, all in one transaction. It is no rebindable port: an overlay
rebinding it could unlock money. Consumers reach it through the optional `WalletCommands.addTurnoverRequirement` and
`WalletReader.readTurnover`.

**The rule.** `wallet.turnover.multiplier` (default `'0'`, off). Each credit of a kind in
`creditTypes` (default `deposit`) adds `multiplier x` its pivot-currency value at credit time, one
entry per credit, deduplicated on `(source, source_ref)`. A real stake adds its pivot value times the
product percent at bet time; a reversal subtracts it. Sportsbook counts at settlement. The
requirement is pooled across currencies and never expires. Play past it is not banked.

**The gate.** While `remaining` exceeds `dustThreshold`, or any entry is unpriced, every withdrawal
and every outbound gift, rain or donation debit is refused with `TurnoverLockedError`
(`turnover_requirement_unmet`, CONFLICT). There are no partial withdrawals. The check runs after the
bonus lock's `onOutflow`, so bonus-locked money answers `bonus_funds_locked` first.

**Lock order.** Extends ADR-0064: wallet row, balance row, grants in id order, the `wallet_turnover`
row, then its entries.

**Stricter, never the sum.** Balance reads report one `locked`: the whole balance while turnover is
unmet, else the bonus lock. `bonusLocked` is the bonus lock alone, which still limits a swap.

**Swaps.** A swap passes the turnover lock, since the money stays with the player; coins swapped in
add a `swap_in` requirement when configured.

**Pending pricing.** A credit with no pivot rate is still credited. Its entry is stored `pending` and
priced at the first rate available, by a cron job and before a withdrawal attempt, each in a
transaction of its own, so a price survives a refused withdrawal. While anything is pending the gate
fails closed.

**Transfer credits.** `wallet.transferCredits` picks how gift, rain and donation credits land:
`bonus_grant` (default) or `cash`, a ledger credit plus a turnover entry. A cash credit locks the
recipient's wallet row, so a caller moving money between players first calls
`WalletCommands.lockWallets` with every player involved, in `userId` order.

**Staff clear.** Staff with `turnover:clear` (compliance roles by default) zero a player's requirement
with a reason, audited and emitted as `wallet.turnover.cleared` in one transaction. A stake placed
before the clear neither counts toward nor is taken back from a later requirement. Staff with
`turnover-config:update` may override per-product percents for new stakes.

**Grant conversion.** The bonus module's idempotent helper turns live gift, rain and donation grants
into cash, with a requirement equal to each grant's remaining wagering. A grant that pays no cash
completes with none. A grant with an open round is skipped and counted,
and `after`/`nextCursor` page the batch.

## Consequences

- One wallet migration adds three tables and two nullable `wallet_transaction` columns.
- Approving a queued withdrawal does not re-check the requirement.
- With multiplier `0` the rule is off, and the read routes answer `enabled: false`.
- A priced entry keeps its rate, so a later rate change does not move it.
- The staff-clear cut-off is by timestamp: a reversal whose transaction opened before a clear that
  committed first subtracts nothing, even for a stake placed after that clear. The window is the
  reversal's own wait for the wallet lock.
- A stake is never an outflow, so a product where one player's stake becomes another's win is outside
  this lock; such an operator should weigh another control.
- An older instance applies no gate, so enable the multiplier only once every instance runs this
  release.

# ADR-0065: Deposit turnover requirement

**Date**: 2026-11-24
**Status**: Accepted

## Context

Anti-money-laundering rules in many markets require a deposit to be wagered some number of times
before it leaves the platform. Without that rule a player can deposit, place nothing, and withdraw
or gift the money to another player, layering funds through the operator. ADR-0064 locks only
bonus money. Many operators need no such rule, so it must be generic, opt-in, and off by default.

## Decision

**Wallet-internal, not a port.** The requirement lives in the wallet module: its own tables, a
`TurnoverService`, and hooks on the wallet's own credit, stake and outflow paths, all on the
wallet's transaction. It is not a rebindable port, because an overlay that rebinds it could unlock
money. Consumers reach it through the optional
`WalletCommands.addTurnoverRequirement` and `WalletReader.readTurnover`.

**The rule.** `wallet.turnover.multiplier` (default `'0'`, off). Each credit of a kind in
`creditTypes` (default `deposit`) adds `multiplier x` its pivot-currency value at credit time, one
entry per credit, deduplicated on `(source, source_ref)`. Each real stake adds its pivot value at
bet time times the product percent; a reversal subtracts it. Sportsbook counts at settlement. The
requirement is pooled across currencies and never expires. Play past it is not banked.

**The gate.** While `remaining` exceeds `dustThreshold`, or any entry is unpriced, every withdrawal
and every outbound gift, rain or donation debit is refused with `TurnoverLockedError`
(`turnover_requirement_unmet`, CONFLICT); there are no partial withdrawals. The check runs after
the bonus lock's `onOutflow`, so bonus-locked money answers `bonus_funds_locked` first.

**Lock order.** Extending ADR-0064: wallet row FOR UPDATE, balance row, grants in id order, the
`wallet_turnover` row, then its entries.

**Stricter, never the sum.** Balance reads report one `locked` amount: the whole real balance while
turnover is unmet, else the bonus lock. `bonusLocked` reports what a swap may still not move.

**Swaps.** A swap passes the turnover lock, since the money stays with the player; the coins
swapped in add a `swap_in` requirement when that kind is configured.

**Pending pricing.** A credit with no pivot rate is still credited. Its entry is stored `pending`
and priced at the first rate available, by a cron job and before a withdrawal attempt, in a
transaction of its own, so the price stays when the withdrawal is refused. While anything is
pending the gate fails closed.

**Transfer credits.** `wallet.transferCredits` picks how gift, rain and donation credits land:
`bonus_grant` (default, as today) or `cash`, a ledger credit plus a turnover entry. A cash credit
locks the recipient's wallet row, so a caller moving money between players first calls
`WalletCommands.lockWallets` with every player involved, which locks them in `userId` order.

**Staff clear.** Staff with `turnover:clear` (compliance roles by default) zero a player's
requirement with a reason, audited and emitted as `wallet.turnover.cleared` in one transaction.
Staff with `turnover-config:update` may override per-product percents for new stakes.

**Grant conversion.** The bonus module ships an idempotent helper that turns live gift, rain and
donation grants into cash, with a turnover requirement equal to the grant's remaining wagering. A
grant that pays no cash completes with no requirement. A grant with an open round is skipped and
counted, and `after`/`nextCursor` page the batch.

## Consequences

- One wallet migration adds three tables and two nullable `wallet_transaction` columns.
- Approving a queued withdrawal does not re-check the requirement.
- With multiplier `0` the rule is fully off, and the read routes answer `enabled: false`.
- The requirement is valued in the pivot currency, so a rate change after a credit does not move it.
- A stake is never an outflow, so a product where one player's stake becomes another's win is
  outside this lock; an operator running one should weigh a further control.
- An older instance applies no gate, so turn the multiplier on only after every instance runs this
  release.

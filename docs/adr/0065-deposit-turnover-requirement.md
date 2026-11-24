# ADR-0065: Deposit turnover requirement

**Date**: 2026-11-24
**Status**: Accepted

## Context

Anti-money-laundering rules in many markets require real money a player deposits to be wagered
some number of times before it leaves the platform. Without that rule a player can deposit, place
nothing, and withdraw or gift the money to another player, which layers funds through the
operator. ADR-0064 locks only the money a bonus ties up. Many operators need no such rule, so it
must be generic, opt-in, and off by default.

## Decision

**Wallet-internal, not a port.** The requirement lives in the wallet module: its own tables, a
`TurnoverService`, and hooks on the wallet's own credit, stake and outflow paths, all on the
wallet's transaction. It is not a rebindable port, because an overlay that rebinds it could unlock
money, and the wallet owns every path the rule observes. Consumers reach it through the optional
`WalletCommands.addTurnoverRequirement` and `WalletReader.readTurnover`.

**The rule.** `wallet.turnover.multiplier` (default `'0'`, off). Each credit of a kind in
`creditTypes` (default `deposit`) adds `multiplier x` its pivot-currency value at credit time, one
entry per credit, deduplicated on `(source, source_ref)`. Each real stake adds its pivot value at
bet time times the product percent; a reversal subtracts it. Sportsbook counts at settlement. The
requirement is pooled across currencies, never expires and never forfeits. Play past the
requirement is not banked: a new credit starts from `progress = required`.

**The gate.** While `remaining` exceeds `dustThreshold`, or any entry is unpriced, every withdrawal
and every outbound gift, rain or donation debit is refused with `TurnoverLockedError`
(`turnover_requirement_unmet`, CONFLICT). There are no partial withdrawals. The check runs right
after the bonus lock's `onOutflow`, so a withdrawal over bonus-locked money answers
`bonus_funds_locked` first, and a turnover refusal rolls a `forfeit`-mode grant forfeit back with
the transaction.

**Lock order.** It extends ADR-0064: the wallet row FOR UPDATE, the balance row, the grants in id
order, then the `wallet_turnover` row, then its entries. Staff clear and the pricing job take only
the last two.

**Stricter, never the sum.** Balance reads report one `locked` amount. While turnover is unmet it
is the whole real balance; otherwise it is the bonus lock. The bonus-only amount is reported
separately as `bonusLocked`, because it is still what a swap may not move.

**Swaps.** A swap passes the turnover lock, since the money stays with the player, but the coins
swapped in add a `swap_in` requirement when that kind is configured. The bonus lock still applies
to swaps.

**Pending pricing.** A credit with no pivot rate is still credited. Its entry is stored `pending`
and priced at the first rate available, by a cron job and by a withdrawal attempt. While anything
is pending the gate fails closed.

**Transfer credits.** `wallet.transferCredits` picks how gift, rain and donation credits land:
`bonus_grant` (default, as today) or `cash`, a ledger credit plus a turnover entry.

**Staff clear.** A staff member with `turnover:clear` zeroes a player's requirement with a required
reason. It is audited (`wallet.turnover.cleared`, actor, reason, before and after) and emits
`wallet.turnover.cleared` in the same transaction. Clearing an empty requirement is a no-op. Staff
with `turnover-config:update` may override per-product percents; overrides apply to new stakes only.

**Grant conversion.** The bonus module ships an idempotent helper that turns live gift, rain and
donation grants into cash, with a turnover requirement equal to the grant's remaining wagering.

## Consequences

- One wallet migration adds three tables and two nullable `wallet_transaction` columns.
- Approving a queued withdrawal does not re-check the requirement.
- Extra play is not banked against future credits.
- With multiplier `0` the rule is fully off: no rows, no rate lookups, no new refusals, and the
  read routes answer `enabled: false` with zeros.
- The requirement is valued in the pivot currency, so a rate change after a credit does not move it.

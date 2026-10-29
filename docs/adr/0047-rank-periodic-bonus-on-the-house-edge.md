# ADR-0047: Rank periodic bonus on the house edge

**Date**: 2026-10-29
**Status**: Accepted

## Context

Each rank tier pays a daily, weekly and monthly bonus. Until now that bonus was a flat amount,
granted to every player who held the tier and met the activity rule. A flat amount costs the
operator the same whether the player gave up a lot or a little to the house, so it is hard to
price safely on low-edge games.

ADR-0046 already carries the game's RTP on `WagerContext.rtp` and prices a bet's house edge,
`realAmount × (1 − rtp)`, with the shared `houseEdge` in `@openora/core/server`. The periodic
bonus can reuse it.

## Decision

**One config switch, defaulting to today.** `promo.rankPeriodic.basis` (`flat` | `margin`) lives
in platform config next to `promo.rakeback`, for the same reason: it changes what the platform
owes, so it ships with a deploy. `flat` behaves exactly as before.

**The tier sets a percent per kind.** `dailyBonusPercent`, `weeklyBonusPercent` and
`monthlyBonusPercent` are nullable, above 0 and at most 100, and are set through the rank
ladder admin. Under `margin` the bonus is
`min(period margin × percent / 100, cap)`. The cap is the tier's existing
`dailyBonus`/`weeklyBonus`/`monthlyBonus`, and null means uncapped. A null percent pays nothing
of that kind. A result that truncates to zero pays nothing. One bet can fund rakeback and all
three bonuses, so a tier whose percents total more than 100 is refused under either basis. A
database check enforces the total on the row as written, since a percent left out of a save
keeps its stored value. The cap bounds the payout by the edge only while rakeback runs on its
`margin` basis with no streak boost.

**The margin is counted on the period counter.** `promo_rank_period_wager` gains a `margin`
column that `RankService.recordWager` adds to in the same upsert as `wagered`. The margin is
converted into the ladder currency at the rate the stake converted at. Only own money counts. A
bet whose rtp is missing, zero or malformed adds zero, as `houseEdge` prices it. The margin is counted under both bases, so a
later switch to `margin` does not start the open periods from zero.

**Under `margin` a counter row is required.** No counter means no edge was given up, so nothing
is paid, whatever `periodicRequiresActivity` says. `periodicMinimumWager` still applies to the
stake `wagered`, not to the margin.

**A rollback lowers the margin.** `promo_rank_round_wager` retains each round's remaining
own-money stake and converted margin, so `WagerReversalArgs` needs no rtp. A reversal locks that
row and removes the reversed stake's proportional share of its recorded margin, bounded by what
remains. A partial reversal uses the round's blended margin. Exhausted rows are deleted; an
unknown round reverses nothing. Period counters are clamped at zero; `wagered` and lifetime
wagered stay monotonic.

**Visible to consumers.** The ladder, the player's rank and `promo.rank.changed` carry the
percents and `periodicBasis`. Under `margin` a client can present the amounts as caps.

## Consequences

- A margin bonus depends on the provider reporting `rtp`. A provider that does not earns its
  players nothing under that basis.
- A rollback that lands after its period closed reduces the period now open, not the closed one.
  The bonus for the closed period is already settled.
- A round row is written for every staked round, under `flat` and for ineligible products too,
  and stays until the round is fully reversed. Most rounds never are, so the table grows with
  play. A retention deadline would change late rollback behaviour and needs its own decision.
- Rounds recorded before this change have no standing margin to reverse.

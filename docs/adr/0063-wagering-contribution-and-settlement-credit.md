# ADR-0063: Wagering contribution and settlement-time credit

**Date**: 2026-11-17
**Status**: Accepted

## Context

A flat percent per game, category or product cannot price a low-edge game below a high-edge
one in the same category, so a player could clear a requirement cheaply on the lowest-edge
game. ADR-0062 let every bet draw on buckets A, B and C, so a bet that counts for nothing could
still spend bonus funds. Progress credited at the stake left a later void guessing what to take
back.

## Decision

**Contribution mode.** A profile carries `contributionMode` (`flat` by default) and, in
`house_edge` mode only, a `referenceEdge`. In `house_edge` the base is
min(1, (1 - RTP) / referenceEdge) and the effective percent is base x the resolved category
percent. An RTP that is missing, zero or below, or one or above, scores 0 percent. All math
truncates. Each save bumps the profile's `version`; a grant snapshots the mode, the edge and the
version with its weights, so an edit never reaches a bonus already held.

**Bet classes and buckets.** Each grant classes the bet under its own terms. A bet is `pvp` on a PvP product, else `contributing` above
zero percent, else `zero`. Offer terms may set
`funds.betClassBuckets: { contributing, zero, pvp }`, each a list of `unlinked`, `linked` and
`bonus`. A class left out may draw on all three, and free real money is always allowed. An
excluded product still never draws on C. A real-money-only product keeps its own rule. When a
class's list leaves a stake uncovered, the `BONUS_WAGERING` port answers `restricted_funds` with
the amount the class may use, and the wallet reports that as `available`. Nothing moves and no
audit row is written. `betClass` governs funding only; PvP progress follows its profile weight.

**Progress is credited at settlement.** A stake adds each grant's weighted share (ADR-0061) to
that grant's round `progress_pending`, and the stake entry records `wageringDelta` 0 plus `wager_inputs`: RTP,
category percent, edge, effective percent, profile version and class. A grant's room for a new
stake excludes what its open rounds already hold. Closing the round credits
min(pending, required - progress) to each grant, with one `progress` entry each. A replayed close
credits nothing; a close also credits pending left on a round already marked settled.
Completion runs in that same settling transaction.

**Reversal takes back the same share.** A reversal returning part of a round's outstanding
stake takes back that share of the progress already credited and the same share of the progress
still pending. A full reversal takes back what was credited. Pending capped at a grant's
room is taken back pro rata to the whole stake. A stake written
before this change carries its progress on its stake entry, taken back the same way.

**Lock order.** Settlement locks the round's grants in id order, then the round rows, as
`wager` does, so a stake and a settlement cannot deadlock.

## Consequences

- One migration, `0016_bonus_wager_contribution`, adds the mode enum, the edge and version
  columns, `progress_pending`, `wager_inputs`, the `progress` entry type, an index on the
  round key, and checks on the edge and on pending.
- The player's entry history gains the `progress` type, a breaking change for an exhaustive
  client.
- Stop old-release instances before 0016 runs: an old settle would close a round without
  crediting its pending progress.
- Progress now lags play until the round settles. A provider that never settles a round never
  credits its progress, as it already never let the grant complete.
- The player and staff grant reads add an optional `pendingWagered`: the progress open rounds
  hold, so a client can show it before it is credited.
- Core ships no edge or class rules. An operator sets the reference edge, the category percents
  and the class buckets for its own market.
- Existing grants score flat and have no class rules; their progress also waits for settlement.

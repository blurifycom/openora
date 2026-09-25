---
'@openora/core': minor
---

Adds a Rank Challenge mechanic to the gamification module: a ladder of tiers, each with a
lifetime real-money wagering threshold, where the first player to cross a tier's threshold wins
its prize, once. A tier's prize may be a cash amount, a physical item, or both; cash is credited
automatically once a claim settles, physical prizes go to a new operator-facing fulfilment queue
(list pending, mark fulfilled with a note, audited).

New player-facing reads: `rankChallenge.get` (progress toward the next unclaimed tier, a top-5
leaderboard, the player's own position) and `rankChallenge.ladder` (public tier list with winner
info). New admin routes under `admin.rankChallenge`: replace the ladder as one set (prospective
only - a claim snapshots its own prize at the moment it is won, so editing a tier afterward never
changes what a past winner was granted), list every claim, and run the fulfilment queue.

Concurrency: two players crossing the same tier at once resolve to exactly one winner via a
unique index on the claim's tier, checked through `onConflictDoNothing` plus a `.returning()`
check rather than a pre-check select, so there is no TOCTOU gap.

New domain event `promo.rank-challenge.won` and notification type (in-app + email), mirroring
`promo.race.won`. New `seedRankChallengeLadder` seed helper, mirroring `seedRankLadder`.

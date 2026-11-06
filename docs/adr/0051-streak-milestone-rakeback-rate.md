# ADR-0051: Streak milestone rakeback rate

**Date**: 2026-11-06
**Status**: Accepted
**Relates to**: ADR-0048 (claimable rakeback on the house edge), ADR-0040 (bonus funds live on the grant).

## Context

The daily casino streak used to pay through a list of milestones, each carrying several reward
kinds: cash, a rolled gift, a bonus and a temporary rakeback boost. The boost was stored on the
player's rank row and added percentage points to the rank's rate (ADR-0048 priced the margin basis
as the house edge times the tier rate plus the boost).

That shape had three problems. An additive boost is worth the same points to every rank, so it was
cheap on a high rank and generous on a low one. A player with no rank, who holds no rank row
to carry a boost, could not earn anything from the streak. And a streak that reset at a fixed day
could never run past it, so the most loyal players stopped progressing.

## Decision

**Two separate things unlock along the streak, configured apart.** A rate row says what rakeback a
player earns from a given day on. A fixed reward says what one-time bonus a given day unlocks. Days
run from 1 to 35, the count has no upper limit and the streak never resets on its own: only a
missed day, or switching the streak off, resets it. Past the last configured day the highest
rate row stays.

**The uplift multiplies, it does not add.** A ranked player's rank rakeback is multiplied by one
plus the row's uplift. The same uplift is therefore worth the same share of the rank's rakeback on
every rank: 5% of 5 is 5.25, never 10. The calculation keeps full precision and only the credit is
rounded.

**A player with no rank earns a share of theoretical gross gaming revenue.** Holding no rank means
the rank row holds no tier. Such a player earns the row's unranked rate on the house edge of the
bet, whatever the rakeback basis is set to, so the formula always needs a usable return-to-player
figure and pays nothing without one. This is the one place rakeback is paid to a player the ladder
does not cover, and it lives with the streak, not the ladder.

**The rate is read when each bet settles, from the streak as it stands.** The rakeback consumer runs
before the streak consumer on the same bet, so the bet that unlocks a milestone earns the previous
milestone's rate and the next bet earns the new one. The rate applies only while the player's last
qualifying day is today or yesterday in UTC, so a broken streak pays nothing even before the daily
close has reset it, and only to the streak's own products. Editing the config changes the rate of
bets from then on; credits already given are never recalculated.

**The accrual records what the streak did.** A claimable accrual keeps which formula the streak
used and the percentage it applied, so an admin can reproduce an amount after the config changes.
The old additive boost column stays for history and is written as zero. The retired boost columns
on the rank row, and the retired milestone columns on the streak config, are no longer read or
written; they are dropped in a later release so a rolling deploy never meets a query naming a
missing column.

**A fixed reward unlocks once per player, and its terms are captured.** The amount, rollover and
claim window are copied onto the reward when its day is first reached, so a later config edit never
changes what a player holds. A day that has unlocked, whether it was then claimed, expired or lost
to a responsible-gambling block, never unlocks again. The one exception is a reward taken back
because a same-day provider rollback undid the day that unlocked it. The claim window runs from the
unlock and survives a reset. A claim after it is refused, and an hourly sweep settles what nobody
claimed, one audit row per reward. A claimed reward becomes a bonus in the currency the player
plays in, priced from dollars at claim time, with a rollover window as long as the claim window.
Claiming with no rate available fails and leaves the reward claimable.

**The switch ends streaks, not rewards.** Switching the streak off stops counting and the next
daily close resets every run; switching it on starts everyone from zero. Rewards already unlocked
stay claimable until their own expiry. Responsible gambling is unchanged: a self-exclusion or
cooling-off forfeits unclaimed rewards without a notification, and nothing is restored when it
ends.

## Consequences

- The streak config, the player streak response and the rakeback accrual row change shape. A
  consumer reading the old reward kinds, the claimable list or the additive boost must move to the
  new fields.
- A stake is counted on the UTC day the wallet accepts it, only its real-money part. Bonus buys are
  not told apart from other casino stakes yet.
- Every streak amount and threshold is in dollars, converted at the rate of the moment.
- The data conversion switches an existing streak off, turns each old bonus reward into a fixed
  reward, leaves no rate rows, and settles rewards waiting under a day that no longer pays. The
  operator re-enables the streak once it has set the new rates.

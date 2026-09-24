# Gamification

Account levels: a ladder of ranks a player climbs by wagering, and the rewards each rank pays.

`docs/catalog.json` is the exhaustive list of this module's tables, routes and events. This file
does not repeat it.

## What this module owns

- **The ladder.** An ordered set of ranks, each with the wagering it requires, a rakeback
  percentage, and up to four reward amounts: one for reaching the rank, and one each for the day,
  the week and the month. What the ranks are called, how many there are and what they cost is the
  operator's pricing, so the platform ships none of it - an operator seeds its own and edits it in
  the backoffice from there on.
- **The counter.** How much each player has wagered, in one currency, for as long as they have
  played. It is what decides their rank.
- **What a rank owes.** A record of every reward earned but not yet paid, and the jobs that pay
  them.

It does not own the money. Every reward is credited by the bonus module through its grant port,
so a rank bonus is the same object as a deposit bonus and lives by the same rules once it exists.

## Rank is a function of wagering, in one currency, forever

A rank ladder needs a single yardstick, because players bet in many currencies. The ladder names
the one it is priced in, and a bet in anything else is converted into it **at the rate of the
moment the bet was placed, and never converted again**. A stored counter is therefore a
statement about the past: this is what the player wagered, measured at the rates that applied
while they were wagering.

The alternative - storing each currency and converting on read - would let a rank move with the
market. A player who reached a rank on Monday would fall out of it on Tuesday because a coin
dropped. **A rank never decreases**, and that rule only survives if the counter is settled at bet
time.

A bet whose currency has no rate available is not counted at all. It is logged with its amount so
it can be found later, and the bet itself is never rolled back for it: refusing a player's bet
because a rate provider is slow would be a worse failure than undercounting their progress.

What counts toward a rank is the raw stake, not what a bonus engine weighted it at. Weighting
belongs to a bonus a player happens to hold; a player's standing must not depend on which bonus
they are carrying. Which products count - casino, live casino, sportsbook - is the operator's
setting, and an empty setting counts every bet.

## The counter is safe only where it is called

Advancing the counter has no idempotency guard of its own. It is called from inside the bet's own
transaction, below the wallet's duplicate-bet guard, which is what makes a replayed bet from a
provider harmless. Anything that moves that call above the guard, or calls it from somewhere
else, double-counts wagering and can pay a reward nobody earned.

## Reaching a rank, and being paid for it

Crossing a threshold does two things in the bet's transaction: it moves the player's rank, and it
records what that rank owed them at that moment. The money moves later, in a job.

The amount is taken when the rank is reached, not when the payout runs. An operator who prices a
reward after players have already passed that rank does not owe them anything retroactively -
they reached it when it paid nothing. This is also why a ladder installed with no amounts is
inert rather than dangerous.

One wager can cross several ranks at once, and each of them pays. A rank whose reward has no
amount pays nothing and is not recorded as owed.

Paying from a job rather than inside the bet is deliberate. A grant that fails - a rate missing,
a currency the wallet cannot place - is retried on the next run instead of being lost, and it can
never roll back the player's bet.

## Periods, and what "played in the period" means

The daily, weekly and monthly rewards pay for a period that has closed. The operator anchors when
that happens: the hour a day closes on, the weekday a week closes on, the day of the month a
month closes on, all in UTC. The anchor decides **both** when the payout runs and which window it
covers, so a payout can never run on a Friday for a Monday-to-Monday week.

The jobs themselves are a plain tick - how often they run is deployment configuration, not a
business decision. Each run pays only a period that closed after the last one it settled, and
each payout carries the period's own key as the grant's idempotency reference. Between the two,
running the job more often, twice at once, or late changes nothing about who gets paid.

"Played in the period" is answered by what the player wagered **inside that window**, accumulated
per period as the bets happen - not by whether they have played since. A bet placed a minute after
a period closed belongs to the next one. The operator decides whether activity is required at all,
and how much of it: a minimum wagered inside the period, or any single bet.

## What a reward is paid in

A ladder can be priced in a unit the wallet cannot hold - a fiat ticker on a crypto-only operator
is the common case. Three settings resolve it, in order: the currency the player actually plays
in, the operator's fixed payout currency, and the ladder's own. The amount is converted at the
rate of the moment it is granted, and the wagering requirement follows the credited amount rather
than the priced one.

Paying in the player's own currency is not a courtesy. A bonus can only be wagered by bets in the
currency it was granted in, so a reward paid in a coin the player never bets with is a promise
they cannot spend.

## Responsible gambling

A player under a responsible-gambling block is paid nothing, and the reward is not held for them
until the block lifts - a bonus waiting at the end of a self-exclusion is an incentive to come
back. If the block cannot be checked at all, nothing is paid to anyone: the module fails closed
rather than paying unchecked.

The bonus module's own grant path does not check this. It is checked here, before every payout.

## What breaks this module

- **A ladder with no settings row, or no ranks.** Both are fail-closed: wagering is not counted
  and nothing is paid. An operator that migrates without seeding gets an inert module, not a
  wrong one.
- **A reward priced with no terms.** An amount without a wagering multiplier and an expiry is not
  paid at all, because nobody decided what the player has to do with it.
- **The wagering engine returning before it reports the bet.** Then only players holding a bonus
  ever advance, and the ladder is quietly dead for everyone else.
- **A missing exchange rate.** Wagering in that currency is not counted, and a payout that needs
  the rate is retried rather than approximated.

## Not built yet

- **Rakeback.** The percentage is on every rank and an operator can already set it, but nothing
  accrues or pays it. It is a share of the house edge - the stake times the game's margin times
  the rank's percentage - so it needs the game's RTP on the bet, and the bonus-funded part of the
  stake to exclude it. Both arrive from the wagering engine's side of the seam.
- **The rank-change event.** A rank change is audited but not announced, so nothing downstream -
  an in-app notification, an analytics fan-out - can react to it. The counter cannot emit from
  inside the bet's transaction; the event has to be returned to the caller and emitted after
  commit.
- **Pruning old period counters.** One row per player per period per kind is written and never
  read again once its period is paid. A sweep will be needed long before it becomes a problem,
  but it is not there today.

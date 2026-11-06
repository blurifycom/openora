# Analytics

The read side over money and player data other modules own: financial reports and the
registration funnel. It owns no tables and moves no money. ADR-0033 records why it is its own
domain, and ADR-0050 why the wallet's GGR is the official one.

`docs/catalog.json` is the exhaustive list of this module's routes and agent tools. This file does
not repeat it.

## Rules every report keeps

- **One currency at a time.** The platform holds no exchange rates for reporting, so every money
  figure is grouped by currency and never summed across currencies.
- **Short-lived cache.** Reports are dashboards on a refresh interval and may lag the ledger by up
  to a minute.

## The official GGR

GGR is read from the wallet ledger: stakes, less stakes returned by a void, less wins, plus wins
taken back. This is the one figure to call GGR in a report, a dashboard or a regulator return. The
financial summary, the GGR trend and the agent's GGR summary all return it.

- **Cash basis.** A stake counts when the wallet debits it and a payout when the wallet credits it.
  A reversal counts in the period it is booked, so a closed period never changes.
- **One rule for every product.** Casino, house games and sportsbook are counted alike, from the
  money that moved, not from each product's own records.
- **It reconciles to balances.** The ledger is append-only and every balance change has a row, so
  GGR ties to what players hold.
- **Sportsbook promotion wins are real wins.** A provider's freebet costs the player nothing, but
  its win is withdrawable money the operator pays, so it is a win inside GGR like any other. A
  promotion-paid stake moves no money and adds nothing to stakes (ADR-0047).

## The financial summary

Per currency, over the range:

- **Deposits and withdrawals,** completed ones only, split by rail.
- **Net deposits:** deposits less withdrawals less bonus credits.
- **GGR,** as above.
- **Bonus cost:** platform bonus credits.
- **Of which sportsbook promotions:** what sportsbook provider promotions paid, read from the
  sportsbook's append-only bet transactions, the same total the sportsbook promotion report shows.
  A settlement adds what its promotion paid, and a reopen takes it back in the reopen's period.
  It is already inside GGR, not in bonus cost, and is never deducted again. A reopen takes back its
  whole promotion part even when the player's balance could not cover it, while GGR takes back only
  what the wallet collected, so the figure can be lower than GGR's promotion share by uncollected or
  written-off sportsbook debt. It is empty when the sportsbook module is not loaded.
- **NGR:** GGR less bonus cost. It does not deduct cashback credits.

## Other figures that are not the official GGR

Two other reports total stakes and payouts. Each answers its own question, and neither is the
official GGR.

- **Revenue by product,** on a settled basis. Its per-product stakes less payouts keeps the field
  name GGR, but it is not the official figure. A completed casino or house-game round counts by its
  start, from the round's own stake and win. A sportsbook stake counts when the provider accepts
  the bet, only its cash part, and a payout when the bet settles; a reopen takes the payout back in
  its own period. A stake reserved but never accepted is left out. Its total can differ from GGR in
  any period, because GGR counts a sportsbook stake at reserve and its reversals as the wallet
  books them.
- **A player's sportsbook net result,** in the sportsbook module. It is the cash stake of the bets
  staked in the range, less the payout of each bet's latest settlement: a per-player activity
  figure for support and risk staff, not revenue. A reopened bet's uncollected reversal is not in
  it (see `docs/modules/sportsbook.md`).

## The conversion funnel

A cohort of players who registered in the range, followed through email verification, first
deposit and first bet. Each step counts only players who passed the one before, so the funnel is
strictly nested.

# ADR-0050: Wallet GGR Is the Official GGR

**Date**: 2026-11-04
**Status**: Accepted

## Context

Three reports total stakes and payouts, and each counts a bet differently:

- The financial summary and GGR trend read the wallet ledger. A stake counts when it is debited, a
  payout when it is credited, and a reversal when it is booked.
- Revenue by product reads each product's own records. A sportsbook stake counts when the provider
  accepts the bet, a payout when it settles, and a reopen takes the payout back.
- The sportsbook player summary reads bet rows as they stand now. A payout counts from each bet's
  latest settlement (ADR-0047).

All three were called GGR. For the same period they can disagree, and an operator reporting to a
regulator needs one number that reconciles.

A sportsbook provider's freebet adds a second question. Its stake costs the player nothing, but
its win is withdrawable money the operator pays, booked as a plain win on the wallet (ADR-0047).
Splitting that win into a bonus credit would make GGR exclude it, but it would also change the
player's transaction list, net deposits and the debt paths for a cost the sportsbook rows already
record.

## Decision

- **The wallet ledger's GGR is the official GGR.** Stakes less voided stakes less wins, plus wins
  taken back, over the ledger, per currency. It is the one figure to report as GGR. It is
  append-only, ties to balances, and uses one rule for every product.
- **Cash basis.** A stake counts when the wallet debits it and a payout when the wallet credits it.
  A reversal lands in the period it is booked, so a closed period never changes.
- **Sportsbook promotion wins are real wins inside GGR.** They stay plain wins on the wallet. The
  financial summary shows what promotions paid, net of reopens, as its own figure, read from the
  sportsbook's append-only transaction rows through the same optional seam the products report
  uses. It is already inside GGR and is never deducted again. It takes a reopen's whole promotion
  part back, as the promotion report does, so it can be lower than GGR's promotion share by
  sportsbook debt the wallet never collected.
- **The other figures keep their basis.** Revenue by product is labelled settled basis; its
  per-product field keeps the name GGR until it moves onto wallet rows. The player summary's figure
  is renamed to net result and described as per-player activity, not revenue.

## Consequences

- Dashboards and regulator returns read GGR from one place, and it reconciles to balances.
- The player summary's contract changes: its GGR field is renamed to net result, a breaking change
  for anyone reading it.
- Revenue by product can still differ from GGR in a period. Moving it onto wallet rows needs the
  wallet to record which product each stake came from.
- NGR stays GGR less bonus cost. It does not deduct cashback credits.
- An analytics process without the sportsbook module reports no promotion figure, the same way the
  products report omits sportsbook.

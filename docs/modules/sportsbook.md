# Sportsbook

A provider-settled sportsbook: a third-party provider runs odds, trading, bet acceptance and
settlement inside its own widget, and core holds the money. ADR-0046 records why the seam is
shaped this way. The rules for any balance change are in `docs/standards/money.md`.

`docs/catalog.json` is the exhaustive list of this module's tables, routes, events and config
fields. This file does not repeat it.

## What this module owns

- **The bet ledger.** A bet and its append-only transaction history, one row for every provider
  transaction core applied, each committed with the wallet move it made. That row is the replay
  answer and the retry guard.
- **Sessions.** The short-lived reference a player's widget carries. Core binds a bet to a player
  through the session it issued, never through a player id the provider echoes back.
- **Operator configuration.** Whether the sportsbook is on, a suspension switch with a reason, the
  currencies it is offered in, the countries it refuses on top of the platform's own geo blocks,
  and the timeouts reconciliation works from.
- **Player restrictions.** An admin can block one player from sportsbook play without touching
  casino play.
- **Sportsbook debt.** What a reversed settlement could not take back, per player and currency,
  with the withdrawal hold that lives exactly as long as the debt.
- **Reconciliation findings.** Everything the ledger noticed but could not decide on its own, for
  an admin to resolve.

## Building a provider bridge

Core ships no callback route and no provider binding. An operator's overlay owns the provider's
HTTP surface and turns each callback into one call on the sportsbook ledger port, defined in
`packages/core/src/contracts/adapters/sportsbook-ledger.ts`. Where the provider's wire protocol
and core disagree, the overlay converts; core never learns a provider's wire format.

### What the overlay provides

1. **The callback routes.** One per provider callback, in the shape the provider calls.
2. **Signature verification, before anything else.** Verify the provider's signature over the raw
   body before parsing it, and fail closed: a missing key, an unknown scheme or a bad signature is
   refused without touching the ledger. Never log the raw body, a session token or the signature.
3. **The outbound provider binding.** Session issue, session revoke and a bet status lookup, as
   the provider port in `packages/core/src/contracts/adapters/sportsbook-provider.ts` declares.
   Its name is the lowercase provider key every ledger call for this provider carries. Each move a
   callback makes is a wallet row under the provider name `sportsbook:<provider>`, with the
   reference `tx:<provider tx id>`. The debt offset a payout triggers and an admin collect take
   each shortfall back under the provider of the bet that owed it, in that bet's round, with
   `offset:<paying provider>:<provider tx id>:<shortfall id>` or
   `collect:<idempotency key>:<shortfall id>`. A deployment binds one provider.
   A revoke must resolve for a session the provider never opened or already closed; a throw is
   retried. A binding without a revoke leaves the widget session open at the provider until it
   expires, though core refuses its session lookups and stakes. Without the binding, session
   issue is refused and reconciliation files findings instead of resolving bets. Session issue
   also needs the platform's `GEO_CHECK_COMMANDS`; without it the sportsbook is unavailable.

### Mapping callbacks to ledger operations

| Provider callback                                    | Ledger operation                                       |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Session or balance lookup                            | resolve the session                                    |
| Stake placed, before the provider accepts it         | reserve                                                |
| The provider accepted the bet                        | confirm, with the accepted terms if the odds changed   |
| The provider rejected the bet                        | cancel, as rejected                                    |
| The bet was discarded, possibly before core saw it   | cancel, as discarded                                   |
| Win, loss, void, half result or cash-out             | settle, with the result label and the total payout     |
| Rollback of a settled bet                            | reopen                                                 |
| A corrected result (rollback, then a new settlement) | reopen, then settle at the version the reopen returned |

- **Pass the provider's own transaction id unchanged.** Every operation is idempotent on it plus a
  fingerprint of the request, a confirm's accepted terms included. A retry with the same content
  moves nothing and gets the answer the
  first call got, even when the bet has moved on since; the same id with different content is
  refused and filed as a finding. Do not deduplicate in the overlay. Ids that start with
  `core-align:` are core's own and are refused the same way.
- **One reserve per bet.** A second reserve for a bet core already holds, under a new transaction
  id, is refused and filed.
- **Send the total payout, never a delta.** A provider that sends deltas is converted in the
  overlay. A loss settles with a zero payout; a void pays back exactly the stake.
- **Pin the version when the provider gives one.** A reopen moves the bet to its next version, and
  a settle or reopen that names a version only applies to that version, so a late duplicate from
  before a correction cannot land on the corrected bet.
- **A rollback that names a transaction is resolved to its bet in the overlay.** Core reopens per
  bet.
- **Never call the port inside the overlay's own database transaction.** Each operation opens and
  commits its own, so the overlay can never take a lock out of order or hold one across its own
  network call.

### Answering the provider

An operation either applied, replayed, or was refused. Applied and replayed both carry the bet's
state after the operation and the player's real balance in the bet currency; answer the provider
with them the same way. A tombstone, a cancel for a bet core never saw, carries neither. A refusal
carries a typed reason, which the overlay maps to the provider's error code:

- the player may not play now: blocked, restricted, suspended, over a limit, or a session that is
  no longer live;
- the balance does not cover the stake;
- the operation does not fit the bet's state, or the bet is unknown;
- the transaction id was reused for different content, or the amount is invalid for the bet's
  currency or result.

A malformed amount is refused as an invalid amount, and a malformed session id as a session that
is no longer live. Any other malformed field is a bug in the overlay, and the call throws.

A reused transaction id, an invalid amount, and an operation on a bet core already moved past it or
dropped also file a finding, so a late provider callback is never refused unseen. The one exception
is a reserve after a tombstone: that is the race the tombstone exists for. A refusal writes
nothing else, so the provider may retry it or treat it as final.

## Rules that are easy to get wrong here

- **Only stakes are gated.** Configuration, suspension, restriction, the sportsbook's blocked
  countries and play eligibility are checked when a session is issued and again, under the locks,
  when a stake is reserved. The platform's geo check runs at session issue only, and reserve does
  not repeat it. Responsible-gambling limits are checked only at reserve, by the wallet debit that
  takes the stake. Confirm, cancel, settle and reopen are never gated: a disabled or
  suspended sportsbook still settles every open bet.
- **No network call runs inside a ledger transaction.** Session issue writes its row, commits, then
  calls the provider; a revoke calls the provider after its commit; reconciliation and align ask
  the provider before they open a transaction.
- **Every path takes its locks in one order.** The config lock (shared for a stake or a session,
  exclusive for a config write), then the player lock, then the bet lock (taken only to tombstone a
  bet core never saw), then the player's identity row, then the wallet rows, then the audit chain
  last. A finding is written before any audit row. The order is stated once, in the module's lock
  helper, and a new path follows it.
- **A cancel can arrive before the reserve.** It leaves a tombstone, and the reserve that arrives
  later is refused, so the stake is never taken for a bet the provider already dropped.
- **The provider is the outcome authority.** An admin never types a result or a payout. The only
  manual correction is align-with-provider: core asks the provider for the bet's status and applies
  it through the same guarded ledger operations a callback uses. A status core cannot reach from
  the bet's state, or a settlement the ledger would refuse, becomes a finding, not a move. Align
  and reconciliation apply the answer only to the bet as it stood when they asked: a callback that
  moved the bet during the lookup makes the answer stale, so nothing is applied, and an admin
  align answers 409 `bet_changed` to be run again.
- **A payout above the bet's potential payout is paid and filed.** Refusing it would strand the
  player's winnings. The potential payout is the accepted one when the confirm carried terms.
- **Accepted terms change only the odds.** A confirm may carry the potential payout and the legs
  the provider accepted, always both. The legs must be the reserved ones in the same order, with
  only the odds changed; a leg cannot drop or gain its odds. With decimal odds the payout follows
  their product: it rises when the product rises, falls when it falls, and holds when it holds, so
  `2.5` rewritten as `2.50` moves nothing. Odds in another format only let the payout change when
  their text did. The payout need not equal stake times odds, since providers round and cap their
  own way, but it must fit the currency's decimals and be at least the stake. The stake never
  changes. Valid terms replace the bet's potential payout and legs; the reserve's transaction row
  keeps the original ones. Terms that do not fit are refused as `invalid_amount` and filed, and the
  bet stays reserved. If valid terms never arrive, reconciliation confirms the bet on its reserved
  terms from the provider's status, and the open finding tells an admin to check the payout.
- **The country list blocks, it does not allow.** The platform's geo check runs first. The
  sportsbook's `blockedCountries` only adds countries; an empty list offers the sportsbook wherever
  the platform trades. Session issue refuses a country it cannot resolve, and reserve refuses a
  session whose country was listed after it opened, as `session_invalid`. The player's language
  tag is passed to the provider at issue, refused when malformed, and never stored.
- **A reversal never overdraws a balance.** A reopen takes back what the settlement paid, a win as
  a `win_reversal` and a voided stake as a `bet`, from the real balance. What it cannot take back
  becomes debt in that currency, a withdrawal hold, and a finding, in the same transaction.
- **Debt is recovered from later sportsbook wins first.** A settlement in that currency pays the
  full win, then takes back up to the outstanding debt. An admin can also collect from the
  balance, or write the debt off with a reason; both, like align and resolving a finding, need
  `sportsbook:configure` and `transaction:refund`. Each request carries an idempotency key whose
  retry gets the first answer and moves nothing new. A refused request keeps no answer, so its
  retry runs again. The hold is released once no debt is outstanding in any currency, so writing
  off one currency's debt keeps the hold while another is still owed.
- **Reports are cash-basis for a reopened bet.** GGR and responsible-gambling spend count what was
  collected, when it was collected, so an offset can land in a later period than the payout it
  reverses. A written-off debt never reaches the ledger. An offset or an admin collect takes each
  reopen's shortfall back, oldest first, in that bet's round and as the leg type the reopen used,
  so responsible-gambling loss nets it into the round it completes, whichever payout it came out of.
  A `win_reversal` recovered into a round that started before the limit window stays out of that
  window's loss, like the rest of that round.
- **Sportsbook stakes are real money only.** The bonus engine never draws, attributes or
  max-bet-checks them. They always count toward responsible-gambling spend. Rank level counts
  them as the operator's rank setting says. Rakeback and the rank challenge leave them out by
  default, until the operator adds them; a ladder upgraded from before those lists existed counts
  every product, sportsbook included.
- **Cooling-off and self-exclusion end play at once.** Either one queues a retried job that revokes
  every live sportsbook session, at core and at the provider, and audits the revoke. A stake that
  lands before the job runs is still refused, because reserve checks play eligibility under its
  locks, and the provider's session lookup refuses the player too. A session the provider opened
  while the player was being restricted is revoked at the provider too, and the issue fails. A
  provider revoke that fails is retried by the job, then by every reconcile pass until the session
  expires, least recently tried first. A revoke counts as acknowledged only when it was sent after
  core recorded the provider's open, so a revoke that raced the open is sent again.
- **Every money leg re-evaluates the loss-limit thresholds.** A placed, cancelled, settled or
  reopened bet each queues a responsible-gambling evaluation for the player, and so does every debt
  change, since an admin collect writes loss of its own.
- **Reconciliation never refunds blindly.** A reserve the provider never confirmed is resolved
  against the provider's own bet status. After a few passes that leave it reserved, it is filed for
  an admin instead of retried forever. An accepted bet still open well after its last event started
  is filed as overdue; core does not settle it on its own.
- **Every change is audited in its own transaction.** The guard is the first line of every admin
  handler. A config write, suspension, restriction, debt collection, write-off, align, resolved
  finding and every provider callback that moves a bet write their audit entry in the transaction
  that changes the state, as its last lock. An align writes its own entry instead of the bet's.
- **Every bet, debt, balance and restriction event commits with its change.** Each is written to
  the outbox in the transaction that made the change, so it exists if and only if the change
  committed, and is delivered at least once. The RG evaluation and the session revoke it triggers
  each run once per event.

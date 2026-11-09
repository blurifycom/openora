# Wallet

The money module: what it owns, and the invariants that are easy to break. The rules for any
balance change are in `docs/standards/money.md`; the crypto-rail rules are in
`docs/standards/custody.md`. `packages/core/src/wallet/AGENTS.md` routes between them.

`docs/catalog.json` is the exhaustive list of this module's tables, routes and events. This file
does not repeat it.

## What this module owns

- **The ledger.** A player's balance is a row here, and its transaction history is immutable. No
  chain and no vendor holds a per-player balance. A database trigger denies deleting a
  `wallet_transaction` row and rewriting what defines it (amount, type, currency, time, idempotency
  key, reference value); only the status, review and provider reference columns move, and
  `balanceAfter` and `realShare` are filled once and then frozen. `balanceAfter` is the
  player's balance in that currency after the row moved money, set in the same transaction as the
  move; it is null on older rows, on a deposit that has not settled, and on a refund (which writes
  no row of its own). A withdrawal request is stamped when it is made, since that is when the
  balance is debited. For a stake partly funded by a bonus the ledger `amount` is the whole stake
  while the balance moved by the real part only; a win or bet reversal on such a round likewise
  writes the full `amount` but moves the balance by the real share. A row in a final status
  (`completed`, `failed`, `rejected`, `cancelled`, `refunded`) cannot be reopened by the trigger.
  Cleanup is TRUNCATE, which the trigger lets
  through; a migration that has to repair rows disables the trigger itself.
- **The product on a history row.** A row whose provider name starts with a product and a colon,
  as `sportsbook:<provider>` does, reports that product; any other row reports `product: null`.
  The `products` filter matches those prefixes in SQL before paging, so `total` agrees with it. The
  wallet knows only the product names, never what a product's rows mean.
- **The asset catalog.** The currency-and-network pairs the operator accepts, and for each pair the
  vendor's own asset identifier, the minimums, the fee, and independent switches for deposit and
  withdrawal. Which pairs exist is operator configuration, not code.
- **The custody surface.** Issued deposit addresses, saved payout destinations, per-player vendor
  containers, the sweep, reconciliation findings, and the withdrawal approval path.
- **Its agent surface.** A read tool over a player's balances, recent money movement and
  withdrawals still awaiting a decision, and an action type that holds a player's waiting
  withdrawal for manual review. Both are served only through the MCP kernel (ADR-0042).
- **Read-only money facts for other modules.** Lifetime deposits and withdrawals, the last
  deposit, turnover and recent withdrawal requests, read through the wallet's read port rather
  than its tables. Every total is priced into the fx pivot at today's rates and reads as
  unknown, never as a partial sum, when one of its currencies has no rate. A deposit counts from
  when it reached the balance, so a held one counts from its release, and a withdrawal request
  counts exactly when the auto-approval velocity check would count it.

## Rules that are easy to get wrong here

- **A bet reversal always leaves an audit row, written in the credit's transaction.** A bet or win
  at or above `wallet.significantAmountThresholds[currency]` does too (a decimal string per
  currency; a currency without an entry, or no map, records nothing). The threshold is compared per
  single bet or win in its own currency; aggregates over a window are not tracked.

- **A currency does not identify a chain.** Anything that reconciles, prices, or limits works on
  the currency and the network together. Only a fiat rail and an internal movement have no network.
- **Every ledger row records its direction explicitly.** Direction is never inferred from the kind
  of transaction: a cash transfer between players writes the same kind for the sender's debit and
  the recipient's credit.
- **A donation, a gift and a rain credit their recipient a bonus grant, never cash.** The sender's
  leg is an ordinary cash debit of the transfer's own kind. The recipient's leg is a wagered bonus
  grant: it writes no ledger row and moves no settled balance. A credit of any other kind is paid
  as that kind says, so a tip is paid as cash, and an integration that wants a wagered transfer
  sends a donation. The grant is deduplicated on the recipient, the transfer's kind and the
  caller's reference, without the provider name, so that reference must be unique per transfer
  across provider names. A credit the wallet refuses for a missing wallet or a currency
  mismatch is reported as a refused outcome, not thrown, so a caller that has already debited the
  sender in the same transaction must fail on it to roll the debit back.
- **A deposit, withdrawal or manual adjustment records its reference value once, when written.**
  The reference currency is the player's deposit-limit currency, else their wager-limit currency,
  else `wallet.defaultReferenceCurrency`. The rate and its timestamp are stored with it and never
  recalculated. With no fresh rate the row is not written: a request fails with a typed error, and a
  deposit webhook fails so the vendor redelivers it.
- **An address-based deposit under its asset's minimum is not credited.** The floor is the row for
  the event's network. With none named it is the row of the one network the address was issued
  on for that currency, and if the address has no such row or several, the lowest row. A row with
  deposits switched off still counts, and a named network with no row has no floor. A zero amount
  is refused whatever the floor, with `minDeposit: null` when none applies. The refusal, a `detected` status and a `failed` status each leave one audit row under
  the player, guarded by `wallet_deposit_status_event` in the same transaction, so a redelivery or
  a poll adds nothing. The first refusal stands if the minimum later drops. A credited or refunded
  deposit audits no later status, and a failed one no later detection. A refused deposit never
  becomes a `missing_deposit` finding: its own `below_minimum_deposit` finding is filed in the
  refusal's transaction, carries the address, tag, tx hash and sender, can be credited or refunded
  by an admin, and is left out of the open count behind `alertThreshold`. The finding and the audit row
  name a network only when the event reported one or the address has a single row of that
  currency. With no network named, an address holding several currencies resolves to its row of
  the event's currency. A status event in another currency than every row of its address, with no
  network named, is logged and records nothing. An event with a malformed amount or an empty id
  answers an error on the webhook, so the vendor retries it. An amount with more decimals than the
  ledger keeps is malformed too, and is never rounded. The poll files a polled deposit with a
  malformed amount as a `missing_deposit` finding with no amount and the raw string, escaped and
  cut to 200 characters, in its detail. An admin can only dismiss it until a readable report of the
  same id completes the open row, once and with an audit record of both amounts; a dismissed or
  resolved finding stays as it was. An id already on the ledger or refused below minimum files
  nothing, and a blank id or a malformed status event is logged and skipped. A
  finding for a zero amount can be dismissed but never credited.
- **A bet row records what the bet was placed on.** `wager_product` comes from its `WagerContext`,
  and so does `wager_rtp` when it is a fraction in [0, 1]. A malformed rtp is stored as NULL rather
  than refusing the bet. `houseEdge` in `@openora/core/server` prices it.
- **A withdrawal's network fee comes out of the amount the player entered.** The player is debited
  the full amount, the row records the fee, and the provider pays out the amount minus the fee. An
  amount that does not exceed the fee is refused. A refund returns the full debited amount.
- **Whether a withdrawal needs KYC is compliance's decision, asked through `KYC_WITHDRAWAL_POLICY`.**
  `kyc.gateWithdrawals` switches the request-time check on; auto-approval always asks. Without a
  bound policy, every gated withdrawal needs an approved KYC status.
- **A player carrying the `withdrawal_lock` tag cannot take money out.** The request is refused
  before any debit, and neither an admin nor auto-approval can approve a withdrawal that was
  already waiting when the lock landed; it stays queued and can still be rejected. The tag is
  read through `PLAYER_TAGS`; with no tag module bound, no player can be locked.
- **A module's withdrawal hold blocks every withdrawal the same way, under its own reason.** A
  module places and releases its hold through `WALLET_COMMANDS` in its own transaction, keyed by
  (player, source), and releases only its own. The wallet audits each change in that transaction.
  A player with no wallet row cannot be held. It is not the `withdrawal_lock` tag: that one is an
  investigation an admin owns, and a hold lives exactly as long as the state the module keeps
  (ADR-0046). A hold or lock that lands after an approval sends the withdrawal back to the queue
  before the provider call, and that step writes its own audit row and
  `wallet.withdrawal.requeued` event.
- **A correction debit is never refused for a short balance.** It collects what the balance holds
  and reports the rest as a shortfall the calling module records as debt. Its ledger row carries
  what was collected and what was asked, a zero collection included, so a retry with the same
  reference replays the first result and one asking a different amount is refused. Each row it
  writes is audited as `wallet.correction.debited` in the caller's transaction. It never takes
  back more than its round paid into the real balance: a payout reversal is capped by the real share
  of the round's wins less its earlier reversals, and a re-collected stake by the real share of the
  round's stake reversals less its earlier corrections. Correction and hold audit rows are filed
  under the player.
- **Every bet, win and reversal leg of a round carries its `externalRoundId`.** RG spend nets a
  round's legs by it, and a leg without one never offsets a stake. A correction debit without one
  is refused, since a reversal outside its round would drop out of loss spend, and a plain `debit`
  or `credit` never writes a `win_reversal`. A round's payouts and reversals count only when all
  its bets fall inside the limit window, and a round's stake never nets below zero.
- **A withdrawal asks for the Withdrawal PIN, and pays only an address that has waited 24 hours.** The
  PIN is checked through `WITHDRAWAL_SECURITY` before any other check, so every guess is counted; five
  wrong ones in a row lock withdrawals for 30 minutes, and a right PIN does not lift the lock. The
  destination must be in the player's address book and saved more than 24 hours ago, so an address named
  only at withdrawal time cannot walk around the wait. Auto-approval holds such a payout for a human
  as well. Saving an address asks for the password (and the 2FA code when enrolled) and mails the player.
- **Cross-module money moves through the wallet's command port, inside the caller's transaction.**
  Another module never reads or writes wallet tables directly, and a transfer is never settled over
  an event.
- **A vendor call is not transactional.** Persist a recoverable state first, make every settlement
  transition idempotent, and compensate a failed held withdrawal exactly once.
- **The balance stream carries a signal, not an amount.** A dropped frame must not be able to leave
  a stale number on screen, so the client refetches. Every event that moves a settled balance
  publishes one, both legs of a cash transfer between players included. A transfer credited as a
  bonus grant publishes one for its sender's debit only.
- **A held withdrawal waits for an admin.** Holding moves no money: the funds were taken when the
  withdrawal was requested. An admin approves or rejects a held withdrawal the same way as one
  still waiting, and auto-approval only ever takes a withdrawal nobody has held. Only a waiting
  withdrawal can be held, and holding one already held changes nothing, so a replayed proposal
  holds it once.
- **Buying crypto with fiat never credits the ledger.** An on-ramp vendor delivers to an address
  this module issued, and the ordinary deposit path credits the coins when they land. The vendor's
  status updates move only the order record, owned by `wallet_on_ramp_order`, and the audit log.
- **Admin actions are guarded and audited.** The guard is the first line of the handler. A manual
  adjustment, an approval, a rejection, a hold, a catalog edit and a resolved finding each write an
  audit entry naming the actor and the reason.
- **The webhook path resolves the verifier and the adapter from the same provider entry,** and
  fails closed when either is missing.

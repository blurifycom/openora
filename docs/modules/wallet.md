# Wallet

The money module: what it owns, and the invariants that are easy to break. The rules for any
balance change are in `docs/standards/money.md`; the crypto-rail rules are in
`docs/standards/custody.md`. `packages/core/src/wallet/AGENTS.md` routes between them.

`docs/catalog.json` is the exhaustive list of this module's tables, routes and events. This file
does not repeat it.

## What this module owns

- **The ledger.** A player's balance is a row here, and its transaction history is immutable. No
  chain and no vendor holds a per-player balance.
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

- **A currency does not identify a chain.** Anything that reconciles, prices, or limits works on
  the currency and the network together. Only a fiat rail and an internal movement have no network.
- **Every ledger row records its direction explicitly.** Direction is never inferred from the kind
  of transaction: a player-to-player transfer writes the same kind for the sender's debit and the
  recipient's credit.
- **A deposit, withdrawal or manual adjustment records its reference value once, when written.**
  The reference currency is the player's deposit-limit currency, else their wager-limit currency,
  else `wallet.defaultReferenceCurrency`. The rate and its timestamp are stored with it and never
  recalculated. With no fresh rate the row is not written: a request fails with a typed error, and a
  deposit webhook fails so the vendor redelivers it.
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
  (player, source), and releases only its own. A player with no wallet row cannot be held. It is
  not the `withdrawal_lock` tag: that one is an investigation an admin owns, and a hold lives
  exactly as long as the state the module keeps (ADR-0046).
- **A correction debit is never refused for a short balance.** It collects what the balance holds
  and reports the rest as a shortfall the calling module records as debt. Its ledger row carries
  what was collected and what was asked, a zero collection included, so a retry with the same
  reference replays the first result and one asking a different amount is refused.
- **Every bet, win and reversal leg of a round carries its `externalRoundId`.** RG spend nets a
  round's legs by it, and a leg without one never offsets a stake. A correction debit without one
  is refused, since a reversal outside its round would drop out of loss spend, and a plain `debit`
  or `credit` never writes a `win_reversal`. A round's payouts and reversals count only when all its bets fall
  inside the limit window, and a round's stake never nets below zero.
- **Cross-module money moves through the wallet's command port, inside the caller's transaction.**
  Another module never reads or writes wallet tables directly, and a transfer is never settled over
  an event.
- **A vendor call is not transactional.** Persist a recoverable state first, make every settlement
  transition idempotent, and compensate a failed held withdrawal exactly once.
- **The balance stream carries a signal, not an amount.** A dropped frame must not be able to leave
  a stale number on screen, so the client refetches. Every event that moves a settled balance
  publishes one, both legs of a player-to-player transfer included.
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

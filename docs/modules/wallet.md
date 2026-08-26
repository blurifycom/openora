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

## Rules that are easy to get wrong here

- **A currency does not identify a chain.** Anything that reconciles, prices, or limits works on
  the currency and the network together. Only a fiat rail and an internal movement have no network.
- **Every ledger row records its direction explicitly.** Direction is never inferred from the kind
  of transaction: a player-to-player transfer writes the same kind for the sender's debit and the
  recipient's credit.
- **Cross-module money moves through the wallet's command port, inside the caller's transaction.**
  Another module never reads or writes wallet tables directly, and a transfer is never settled over
  an event.
- **A vendor call is not transactional.** Persist a recoverable state first, make every settlement
  transition idempotent, and compensate a failed held withdrawal exactly once.
- **The balance stream carries a signal, not an amount.** A dropped frame must not be able to leave
  a stale number on screen, so the client refetches. Every event that moves a settled balance
  publishes one, both legs of a player-to-player transfer included.
- **Admin actions are guarded and audited.** The guard is the first line of the handler. A manual
  adjustment, an approval, a rejection, a catalog edit and a resolved finding each write an audit
  entry naming the actor and the reason.
- **The webhook path resolves the verifier and the adapter from the same provider entry,** and
  fails closed when either is missing.

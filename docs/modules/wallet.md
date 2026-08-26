# Wallet

The money module: what it owns, and the invariants that are easy to break. The rules that
apply to any balance change are in `docs/standards/money.md`; the crypto-rail rules are in
`docs/standards/custody.md`. `packages/core/src/wallet/AGENTS.md` routes between them.

## What this module owns

- The ledger. A player's balance is `wallet_balance`, and `wallet_transaction` is its
  immutable history. No chain and no vendor holds a per-player balance.
- The asset catalog (`wallet_asset`): the `(currency, network)` pairs the operator accepts,
  each pair's provider asset id, minimums, fee, and independent deposit/withdrawal toggles.
- Issued deposit addresses, saved payout addresses, per-player provider containers, the
  custody sweep, reconciliation findings, and the withdrawal approval path.

`docs/catalog.json` is the exhaustive table and route list; this file does not repeat it.

## Rules that are easy to get wrong here

- A currency does not identify a chain. Anything that reconciles, prices, or limits works on
  `(currency, network)`. Only a fiat rail and an internal transaction type carry a null network.
- Every ledger row records its direction explicitly. Do not infer direction from the type: a
  social transfer writes the same type for the sender's debit and the recipient's credit.
- Cross-module money moves through `WALLET_COMMANDS` with the caller's transaction. Never
  import wallet tables from another module and never settle a transfer over an event.
- A vendor call is not transactional. Persist a recoverable state first, make each settlement
  transition idempotent, and compensate a failed held withdrawal exactly once.
- The balance stream publishes a change signal with no amount. A dropped frame must not be
  able to leave a stale number on screen; the client refetches. Wire a publish for every event
  that moves a settled balance, both legs of a social transfer included.
- Admin routes assert `AdminGuard` on the handler's first line. A manual adjustment, an
  approval, a rejection, a catalog edit and a resolved finding each write an audit entry with
  actor and reason.
- The webhook route resolves the verifier and the adapter from the same provider registry
  entry, and fails closed when either is missing.

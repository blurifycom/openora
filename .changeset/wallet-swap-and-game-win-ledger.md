---
'@openora/core': minor
---

Two money paths that never reached the ledger now do. `GameAdapter.endRound` returns the round's outcome, so a settled round credits `win` through WALLET_COMMANDS and records `winAmount` (guarded on the round still being `active`, so a replay never pays twice). A new `SwapService` consumes the previously unused `SWAP_ADAPTER`: `POST /wallet/swap/quote` prices a pair, `POST /wallet/swap` holds the funds as a `processing` `swap_out` leg before calling the vendor and books the `swap_in` credit against the amount actually filled, and `POST /wallet/swap/webhook` (verified by `SWAP_WEBHOOK_VERIFIER`) settles or refunds an async fill. With no `SWAP_ADAPTER` bound the swap routes refuse - the resting state is unchanged.

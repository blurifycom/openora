---
'@openora/core': major
---

Swaps are now written to the audit trail, compared exactly, and bindable to the player who asked for the quote.

- A settled swap records `wallet.swap.completed` and a returned hold records `wallet.swap.refunded`, each in the same transaction as its ledger rows. Until now a swap moved two balances with no audit row at all.
- The idempotent-replay check compares amounts with `moneyEquals` instead of `Number()`. Two 18-decimal amounts that collapse to the same double used to pass as the same swap.
- A fill the vendor reported without a usable amount records `wallet.swap.fill_rejected` with the raw amount it sent, so a desk has something to work from on the one path where a hold is stranded.
- The insufficient-balance check and the fill-amount guard use exact decimal comparison. A vendor fill amount that is not a money string now reads as "no fill" and leaves the swap `processing`, instead of reaching the ledger.
- **Breaking:** `SwapAdapter.getQuote` and `SwapAdapter.execute` receive `userId`. A desk can bind its quote to the player and refuse it from anyone else. An adapter that only _implements_ the port keeps compiling and may ignore the field; anything that _constructs_ those inputs - an overlay calling a swap adapter directly, a test fake asserting on the input object - has to pass `userId`.
- `SwapService` now takes an `audit` dependency. Anything constructing it outside the wallet plugin has to pass an `AuditWritePort`.

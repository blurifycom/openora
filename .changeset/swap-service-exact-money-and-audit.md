---
'@openora/core': minor
---

Swaps are now written to the audit trail, compared exactly, and bindable to the player who asked for the quote.

- A settled swap records `wallet.swap.completed` and a returned hold records `wallet.swap.refunded`, each in the same transaction as its ledger rows. Until now a swap moved two balances with no audit row at all.
- The idempotent-replay check compares amounts with `moneyEquals` instead of `Number()`. Two 18-decimal amounts that collapse to the same double used to pass as the same swap.
- The insufficient-balance check and the fill-amount guard use exact decimal comparison. A vendor fill amount that is not a money string now reads as "no fill" and leaves the swap `processing`, instead of reaching the ledger.
- `SwapAdapter.getQuote` and `SwapAdapter.execute` receive `userId`. A desk can bind its quote to the player and refuse it from anyone else. Adapters that ignore the field keep compiling.

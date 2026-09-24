---
'@openora/core': minor
---

Re-KYC's cumulative-deposit trigger, the `high_roller` tag's lifetime-deposit total, and the withdrawal queue's `large_amount` tag are now priced in a single reference currency before they are compared or summed, instead of adding or comparing raw amounts across whatever currencies a player happens to hold.

A platform with no base currency lets a player deposit and withdraw in several coins at once. `KycVerificationService.handleDeposit` used to sum only the deposits already in the player's own currency field - on a crypto-only platform with no matching wallet currency, that read $0 forever and re-KYC never fired. `WalletReader.getLifetimeDeposit` (the `high_roller` rule's input) and the withdrawal queue's `large_amount` heuristic both summed or compared raw `wallet_transaction.amount` regardless of currency - `1 BTC + 20000 DOGE` read as `20001`.

All three now convert through the already-existing `EXCHANGE_RATE_READER` port: re-KYC sums every currency into the player's own currency field, `getLifetimeDeposit` sums into `exchangeRate.pivot` (`USD` by default), and the queue tag prices the withdrawal into the same pivot before comparing it to `LARGE_WITHDRAWAL_THRESHOLD` (previously a raw, currency-blind compare - the queue tag's own doc comment used to call this "a display hint, not a decision"; it is a decision now).

**Missing-rate behaviour:** a compliance total must never silently undercount because one currency had no quote. Where a per-transaction amount can't be priced (the `large_amount` queue tag), the transaction is flagged anyway rather than dropped from consideration. Where a running total can't be fully priced (re-KYC's cumulative sum, `getLifetimeDeposit`), the new `sumInPivot` helper (`@openora/core/server`) returns a large sentinel instead of a partial number, so the threshold comparison downstream always reads as crossed instead of quietly passing. This trades a possible extra manual review/re-verification for never missing one - flagged here for anyone relying on the previous behaviour.

`WalletReaderService`'s constructor gains two new optional trailing parameters (`exchangeRateReader`, `pivotCurrency`) and `KycVerificationDeps` gains an optional `exchangeRateReader` - both already wired from `EXCHANGE_RATE_READER` in their plugins, no consumer wiring required unless a service is constructed directly outside the plugin.

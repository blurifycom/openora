---
'@openora/core': minor
---

Deposit, withdrawal and manual-adjustment rows on `wallet_transaction` now record their value in the player's reference currency: four new nullable columns, `reference_currency`, `reference_amount`, `reference_rate` and `reference_rate_as_of`. The value is written once with the row and never recalculated. Existing rows and other row types stay `NULL`; nothing is backfilled.

The reference currency is the currency of the player's deposit limit, else of their wager limit, else the new `wallet.defaultReferenceCurrency` config field (`USD` when absent). A row already in the reference currency is recorded at rate `1`.

`RgLimitsPort` gains `referenceCurrency(tx, userId)`. A custom binding of `RG_LIMITS` must implement it; returning `null` falls back to the config default.

The admin transaction list (`AdminWalletTransaction`) gains a nullable `reference` object with `currency`, `amount`, `rate` and `rateAsOf`. The player-facing schema is unchanged. The manual-adjustment audit row carries the same object.

**Behaviour change:** a deposit, withdrawal or manual adjustment in any currency other than the reference currency now needs a fresh rate from `EXCHANGE_RATE_READER`. Without one, a withdrawal request, a deposit request and a manual adjustment answer `503` (`WalletReferenceRateUnavailableError`) and write nothing. A deposit webhook credits nothing and answers an error so the vendor redelivers it; a redelivery of an already-credited deposit needs no rate. An install with no rate provider bound can only move money in its reference currency.

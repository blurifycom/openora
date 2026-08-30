---
'@openora/core': patch
---

The `finance-accounting` role now has `read_write` on the `wallet-asset` resource, so it can manage the currency and network catalog alongside super-admin rather than needing one.

Refusing to delete a wallet asset now says which of three reasons applies. An asset with an issued deposit address raised `WalletAssetInUseError`, whose message speaks about a held balance - so a back-office told the operator to drain a balance that was not the problem. It now raises its own `WalletAssetHasIssuedAddressesError`, also mapped to `CONFLICT`. All three conflict errors carry a `data.code` discriminator, so a consumer keys its copy off the cause rather than parsing one message.

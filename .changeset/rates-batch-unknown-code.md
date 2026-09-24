---
'@openora/core': patch
---

`GET /exchange-rate/rates` answers a source currency the operator does not offer with a null quote instead of rejecting the whole batch.

`GET /profile/display-currency` ignores a saved pick the operator no longer offers and falls back to the player's most valuable balance.

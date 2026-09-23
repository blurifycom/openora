---
'@openora/core': minor
---

New optional `wallet.defaultCurrency` platform config: the active currency reported by `wallet.getBalance`, `wallet.getBalances` and `WALLET_READER` for a player who has no wallet row yet. Absent keeps today's `USD`, so existing deployments see no change. A crypto-only operator sets its settlement coin so a new player is not shown a fiat balance the operator cannot fund.

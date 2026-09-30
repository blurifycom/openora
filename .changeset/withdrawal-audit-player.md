---
'@openora/core': patch
---

Withdrawal audit rows are filed under the player so the player-scoped audit view and `q=<playerId>` find them. `wallet.withdrawal.approved`, `rejected` and `failed` now carry `playerId` (nullable). Approved, rejected, failed, completed, auto-approved and outcome-unknown rows use `resourceType: 'player'` with the withdrawal id in `after.transactionId`; a wallet with no player keeps `resourceType: 'withdrawal'`.

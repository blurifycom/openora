---
'@openora/core': minor
---

`AdminPlayerSummary` (the admin/back-office user-directory enrichment port) gains a required `playerId` field alongside `userId`, so back-office consumers can label a row by the real PAM player id instead of the auth-layer user id.

- `AdminPlayerSummary.playerId` is populated by `DrizzleAdminUserDirectory.lookupPlayers` and `.getPlayerByUsername`, selected from the same inner join that already resolves `username`/`kycStatus`.
- The Transaction Monitor list/detail contract (`AdminTransactionSchema`, inherited by `AdminTransactionDetailSchema`) and the Withdrawal Queue contract (`WithdrawalQueueItemSchema`) both gain a nullable `playerId: UuidSchema.nullable()`, mirroring the existing `playerEmail` nullable pattern - null when the user has no PAM player row.
- `BackofficeService`'s transaction mappers and `WalletService.listWithdrawals` now surface `playerId` from the enriched directory summary.
- `findPlayerIds` (the free-text player search on the admin user directory port) now also matches an exact `playerId` or `userId`, not just email/displayName - previously searching by either id returned an empty result.

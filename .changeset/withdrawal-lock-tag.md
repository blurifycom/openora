---
'@openora/core': minor
---

A new sticky `withdrawal_lock` tag (`WITHDRAWAL_LOCK_TAG`) lets an operator hold a player's payouts, for example during an investigation, while the player can still log in. An admin places and releases it like any other tag, with a reason, and both are audited through `tag.player.assigned` / `tag.player.removed`.

While the tag is active, `wallet.withdraw` refuses the request before any debit with `WithdrawalLockedError` (409, `data.reason: 'withdrawal_locked'`), and `approveWithdrawal` refuses a withdrawal that was already queued when the lock landed. The withdrawal stays in the queue and an admin can still reject it. Auto-approval always skips a locked player, whatever `excludeRiskFlags` is set to. Withdrawal queue items carry a new `withdrawalLocked` boolean.

The `tag_key` enum gains `withdrawal_lock` (tag migration `0005`); run the tag seed to add the catalog row on an existing install.

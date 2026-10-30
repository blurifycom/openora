---
'@openora/core': minor
---

A Withdrawal PIN is now checked on every withdrawal, and a new payout address waits 24 hours.

- `wallet.withdraw` takes `withdrawalPin`. With a PIN set, a missing or wrong PIN refuses the request before any debit; five wrong PINs in a row lock withdrawals for 30 minutes and mail the player. The identity module answers through the new `WITHDRAWAL_SECURITY` port.
- A withdrawal to an address that is not in the player's address book, or was saved less than 24 hours ago, is refused with `DestinationAddressCoolingDownError` (`data.reason` is `withdrawal_address_cooling_down` or `withdrawal_address_not_saved`, with `data.usableFrom`). Auto-approval also skips such a payout. A saved address reports `usableFrom`.
- **Breaking:** `identity.security.removeWithdrawalPin` and `wallet.withdrawalAddresses.create` now require `currentPassword`, and `totpCode` when the account has two-factor, the same proof as setting a PIN.
- New mail templates `withdrawalAddressAdded` and `withdrawalsLocked`, new event `identity.security.withdrawal_pin.locked`, and a migration adding `withdrawal_pin_failed_attempts` and `withdrawal_pin_locked_until` to `user`.

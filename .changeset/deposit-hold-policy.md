---
'@openora/core': minor
---

New optional `DEPOSIT_HOLD_POLICY` port. When an operator binds it, an attributed on-chain deposit the policy returns a reason for is recorded as `on_hold` with that `reviewReason`, moves no balance, and files a `held_deposit` reconciliation finding in the same transaction. The policy runs inside the crediting transaction under the player's deposit lock, so a limit read on `tx` counts every deposit committed before it. A throw rolls the credit back and the webhook fails, so the vendor redelivers it. A redelivered held deposit is never credited, even if the policy would now let it through.

A held deposit emits the new `wallet.deposit.held` event, which the notifications module turns into an in-app notification and an always-sent `depositHeld` mail.

A `held_deposit` finding closes only through two new resolution outcomes:

- `released` credits the held row itself after asking the policy again; it is refused with `DepositStillHeldError` while the policy still names a reason. The row turns `completed` with `reviewedAt` set, and the deposit limit window now counts a deposit from `coalesce(reviewedAt, createdAt)`, so a released deposit counts when it reached the balance.
- `refunded` requires the refund `txHash` and `destinationAddress`, moves the row to the new terminal `refunded` status, and records both in the resolution note and the audit row.

`dismissed` and `credited` are refused for a `held_deposit` (`ReconciliationOutcomeNotAllowedError`). Resolving any other deposit finding (`missing_deposit`, `unattributed_deposit`, `amount_mismatch`, `currency_mismatch`) as `credited` now asks the policy too and is refused while it names a reason; those findings may also be closed as `refunded`.

`PLAY_ELIGIBILITY.isRestricted(userId, tx)` now reads the player row `FOR SHARE` when given a transaction, so a self-exclusion or cooling-off landing mid-way waits for the wager, payout or credit it gates to commit instead of slipping in between the check and the money movement.

New optional `PaymentAdapter.withdrawalDecimals(currency, network)`. When a binding implements it, `withdraw` refuses an amount or fee with more fractional digits than the network pays out with `WithdrawalPrecisionError` (`BAD_REQUEST`), before any debit.

Unbound, deposits behave as before: every attributed deposit is credited and a deposit-limit breach is only flagged.

Migrations: `0030` adds `held_deposit` to `wallet_reconciliation_finding_kind`, `0031` adds `refunded` to `wallet_transaction_status`.

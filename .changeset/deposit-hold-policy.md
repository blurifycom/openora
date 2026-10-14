---
'@openora/core': minor
---

New optional `DEPOSIT_HOLD_POLICY` port. When an operator binds it, an attributed on-chain deposit the policy returns a reason for is recorded as `on_hold` with that `reviewReason`, moves no balance, and files a `held_deposit` reconciliation finding in the same transaction. The policy runs inside the crediting transaction under the player's deposit lock, so a limit read on `tx` counts every deposit committed before it. A throw rolls the credit back and the webhook fails, so the vendor redelivers it. A redelivered held deposit is never credited, even if the policy would now let it through.

A held deposit emits the new `wallet.deposit.held` event, which the notifications module turns into an in-app notification and an always-sent `depositHeld` mail.

A `held_deposit` finding closes only through two new resolution outcomes:

- `released` credits the held row itself after asking the policy again; it is refused with `DepositStillHeldError` while the policy still names a reason. The row turns `completed` with `reviewedAt` set, and the deposit limit window now counts a deposit from `coalesce(reviewedAt, createdAt)`, so a released deposit counts when it reached the balance.
- `refunded` requires the refund `amount` (at most the finding amount, else `ReconciliationRefundAmountError`), `txHash` and `destinationAddress`, moves the row to the new terminal `refunded` status, and records all three in the resolution note and the audit row.

`dismissed` and `credited` are refused for a `held_deposit` (`ReconciliationOutcomeNotAllowedError`).

`refunded` is allowed only for `held_deposit`, `missing_deposit` and `unattributed_deposit`; an `amount_mismatch` or `currency_mismatch` the player was already credited for is refused. Refunding a `missing_deposit` writes a terminal `refunded` deposit row keyed on the vendor id, so a later vendor redelivery replays it instead of crediting it (no balance, no events, no limit check); it is refused with `DepositAlreadyOnLedgerError` if the webhook credited the deposit first. The audit row records `refundDestinationDiffersFromSource` (`null` when the vendor never reported a source address).

Resolving a deposit finding (`missing_deposit`, `unattributed_deposit`, `amount_mismatch`, `currency_mismatch`) as `credited` no longer takes a `transactionId`: the resolve itself credits it as a `completed` `deposit` row keyed on the vendor id, which the deposit-limit window counts. The hold policy runs before any write and refuses with `DepositStillHeldError`. The owner is the ledger row's wallet (an `amount_mismatch` credits only the shortfall) or the deposit address owner, otherwise the optional `userId`; a `userId` that disagrees with the address owner, or none for an unattributed deposit, is refused with `ReconciliationAttributionError`. Every other finding kind still closes as `credited` against an existing matching `manual_credit`.

New optional `sourceAddress` on the `deposit` `PaymentWebhookEvent`; reconciliation findings store it in the new `source_address` column.

`PLAY_ELIGIBILITY.isRestricted(userId, tx)` now reads the player row `FOR SHARE` when given a transaction, so a self-exclusion or cooling-off landing mid-way waits for the wager, payout or credit it gates to commit instead of slipping in between the check and the money movement.

New optional `PaymentAdapter.withdrawalDecimals(currency, network)`. When a binding implements it, `withdraw` refuses an amount or fee with more fractional digits than the network pays out with `WithdrawalPrecisionError` (`BAD_REQUEST`), before any debit.

Unbound, deposits behave as before: every attributed deposit is credited and a deposit-limit breach is only flagged.

Migrations: `0030` adds `held_deposit` to `wallet_reconciliation_finding_kind`, `0031` adds `refunded` to `wallet_transaction_status`, `0032` adds `wallet_reconciliation_finding.source_address`.

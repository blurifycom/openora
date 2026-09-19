---
'@openora/core': minor
---

A withdrawal whose vendor outcome is unknown is now held instead of refunded. `settleApproved` refunds only when `processWithdrawal` throws the new `PaymentRejectedError`, which a `PaymentAdapter` raises when the vendor definitely did not accept the payout. Any other throw - a timeout, a dropped connection, a 5xx - is indistinguishable from a lost response to a payout the vendor accepted and will broadcast, so the row stays `processing`, an audit entry records the unknown outcome, and reconciliation resolves it.

Reconciliation gained the lookup that makes the hold recoverable: the optional `PaymentAdapter.findWithdrawalByReference(transactionId)` is called for a stuck `processing` withdrawal that never stored a `providerRefId`, and a found payout gets its vendor reference back and settles. When the vendor has no record the run files an `unknown_at_provider` finding for a human rather than refunding on ambiguity, and resolving that finding as `credited` now also moves the held row out of `processing` so a late vendor answer cannot pay out or refund on top of the manual credit.

Also in this change: the `completed` write in `settleApproved` is guarded on `processing` so a webhook-driven failure is never overwritten, `providerName` is stamped before the vendor call so reconciliation asks the vendor that received the request, the stuck cutoff is measured from approval rather than from the request, one failing row no longer aborts a reconciliation run, and `PaymentRejectedError` maps to `CONFLICT` on the approve route.

An adapter that throws a plain `Error` for a definite refusal now leaves the withdrawal held until reconciliation or an admin resolves it - raise `PaymentRejectedError` there and implement `findWithdrawalByReference`.

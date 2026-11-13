# ADR-0057: Withdrawal saga with a screening verdict

**Date**: 2026-11-13
**Status**: Accepted. Removes `TAG_EVALUATION_COMMANDS`, the port the wallet called inside its withdrawal transaction.

## Context

The wallet is meant to run in its own process later (ADR-0054 to ADR-0056). A withdrawal request
still called the tag module synchronously inside its own transaction: `evaluateWithdrawalRequested`
assigned `withdrawal_review` on the wallet's connection, and auto-approval then ran right after the
commit. That only worked because both modules shared one database and one process. Moving the
evaluation out naively would open a race: auto-approval could read the player's tags before
screening assigned `withdrawal_review`, and pay a withdrawal that should have waited for a human.

The request-time controls had the same in-process assumption. `WITHDRAWAL_SECURITY` (PIN),
`KYC_WITHDRAWAL_POLICY` and `PLAYER_TAGS` (the `withdrawal_lock` tag) were optional: with the
module behind one not loaded, its check was skipped.

## Decision

**Screening is an event round trip, and only its verdict can trigger auto-approval.**

1. `withdraw` debits, writes the `pending` row and emits `wallet.withdrawal.requested` through the
   outbox in the same transaction. It no longer runs auto-approval and always answers `pending`.
2. The tag module consumes the event. In one transaction it assigns `withdrawal_review` when the
   amount crosses the rule's threshold, and emits `tag.withdrawal.screened`
   `{ userId, transactionId }` (`TagService.screenWithdrawal`).
3. The wallet consumes the verdict and runs the existing auto-approval
   (`autoApproveScreenedWithdrawal`), which reads the player's tags again.

This is race-free because the verdict and the tag commit together: any reader that has seen the
verdict also sees the tag, on any process. The wallet never auto-approves without a verdict.

**No verdict means manual review.** A withdrawal stays `pending` in the admin queue when:

- the player cannot be resolved for a review that is due (logged, no verdict);
- screening throws until the broker dead-letters the event;
- the outbox never delivers.

Each failure fails closed. A redelivered verdict is a no-op: the wallet acts only on a `pending`
row of the same user, and the approval flip is guarded. Malformed payloads on either side are
logged and dropped.

**The three withdrawal controls are required ports.** The wallet declares `WITHDRAWAL_SECURITY`,
`KYC_WITHDRAWAL_POLICY` and `PLAYER_TAGS` in `requiresPorts`, so an install without identity,
compliance or tag refuses to boot. A `SERVICE_MANIFEST` boot names the missing module. Each is
checked at three points:

- at request, before any debit;
- at admin approval, before the flip (auto-approval runs its own KYC and risk-tag gates there);
- after the flip commits, for admin and auto-approval alike, right before the payout call.

| Port                    | Blocks when                       | At request                 | At approval or payout                                    |
| ----------------------- | --------------------------------- | -------------------------- | -------------------------------------------------------- |
| `PLAYER_TAGS`           | `withdrawal_lock` is active       | `WithdrawalLockedError`    | refused, or requeued with reason `withdrawal_lock`       |
| `WITHDRAWAL_SECURITY`   | `pinLockedUntil` is in the future | `WithdrawalPinLockedError` | refused, or requeued with reason `withdrawal_pin_locked` |
| `KYC_WITHDRAWAL_POLICY` | KYC is required and not passed    | `KycRequiredError`         | refused, or requeued with reason `kyc_required`          |

A port that throws refuses the request or the approval. Auto-approval catches the throw and leaves
the withdrawal for a human. `pinLockedUntil` is new on `WITHDRAWAL_SECURITY`. It reads the lockout
without counting a guess.

**The saga reuses the existing statuses.** No new enum value is added:

| Saga state       | `wallet_transaction`                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| requested        | `pending` (or `on_hold` once an admin holds it)                             |
| approved         | `processing` with `provider_name` NULL: flipped, not handed to a vendor yet |
| processing       | `processing` with `provider_name` set: handed to a vendor                   |
| completed        | `completed`                                                                 |
| failed, refunded | `failed`: the refund credit commits in the same transaction as the status   |

`rejected` and `cancelled` stay the admin and player exits from `pending`. `refunded` is not used
for withdrawals.

**Each stuck state files its own finding.** Reconciliation files one finding per withdrawal and
kind, deduplicated on (kind, provider, external id):

- `stuck_withdrawal_requested`: still `pending` after `STUCK_WITHDRAWAL_REQUESTED_AFTER_MINUTES`
  (24 hours). Screening or review never decided it. The external id is the transaction id.
- `stuck_withdrawal_approved` and `stuck_withdrawal_processing`: `processing` past
  `wallet.reconciliation.stuckAfterMinutes`, counted from approval, and the vendor check failed.
  The vendor answering "no record" keeps filing `unknown_at_provider` as before.

These findings are reports only. They never refund, because a payout may still have left. They
can only be dismissed: the withdrawal is still live, so a manual credit could pay it twice.

## Consequences

- No wallet transaction calls the tag module. The tag module needs only the wallet event and its
  own tables, and the wallet needs only the verdict event.
- Auto-approval is now asynchronous. A player sees `pending` first, and an auto-approved withdrawal
  completes once the verdict is consumed. Callers and tests that read the status straight from the
  `withdraw` response must wait for the verdict (`screenedWithdrawalStatus` in
  `@openora/testing`).
- A withdrawal nobody decides is surfaced after a day instead of waiting silently.
- Apps that share a database share an outbox, and any one of them may deliver a verdict. Installs
  that differ in auto-withdrawal config must not share a database.
- Known gaps:
- If a port throws after the flip, the row stays `processing` without a vendor call.
  `stuck_withdrawal_approved` reports it.
- Bonus forfeiture still runs inside the withdraw transaction (`BONUS_LIFECYCLE`).
- The review threshold compares raw amounts across currencies, as before.

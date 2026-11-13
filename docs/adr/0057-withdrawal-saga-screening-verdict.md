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
   `{ userId, transactionId, reviewRequired }` (`TagService.screenWithdrawal`). `reviewRequired`
   is this withdrawal's own amount against the threshold, whether or not the tag was already on
   the player.
3. The wallet consumes the verdict and runs the existing auto-approval
   (`autoApproveScreenedWithdrawal`), which reads the player's tags again. When `reviewRequired`
   is true, or absent (a verdict from a producer older than the field, during a rolling deploy),
   the withdrawal stays for a human while `withdrawal_review` is in the effective
   `excludeRiskFlags`, as it is by default. An operator who removed it from that list chose to
   auto-approve over-threshold withdrawals, and then only the other gates apply.

This is race-free because the review decision travels in the verdict itself, committed with any tag
it assigned. The wallet does not infer it from the player's tags at consume time, so a tag cleared
for an earlier withdrawal before the verdict is consumed cannot let this one through. The wallet
never auto-approves without a verdict, and never on one that asks for a review while the config
excludes `withdrawal_review`.

**No verdict means manual review.** A withdrawal stays `pending` in the admin queue when:

- the player cannot be resolved for a review that is due (logged, no verdict);
- screening throws on every delivery, and the Redis Streams broker dead-letters the event after
  `MAX_DELIVERIES` (5) deliveries;
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
the withdrawal for a human. A throw after the flip sends the withdrawal back to the queue with
reason `control_check_failed` and its own audit row, for admin and auto-approval alike.
`pinLockedUntil` is new on `WITHDRAWAL_SECURITY`. It reads the lockout without counting a guess.

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

- `stuck_withdrawal_requested`: still `pending` or `on_hold` after
  `STUCK_WITHDRAWAL_REQUESTED_AFTER_MINUTES` (24 hours). Screening or review never decided it. The
  external id is the transaction id.
- `stuck_withdrawal_approved`: `processing` with no provider past
  `wallet.reconciliation.stuckAfterMinutes`, counted from approval. Dispatch stamps the provider
  before the vendor call, so no vendor was asked to pay it, and reconciliation files it without
  asking one.
- `stuck_withdrawal_processing`: `processing` with a provider past the same cutoff, when the status
  check failed. The vendor answering "no record" keeps filing `unknown_at_provider` as before.

These findings are reports only. They never refund, because a payout may still have left. They
can only be dismissed: the withdrawal is still live, so a manual credit could pay it twice. Each
closes by itself, as a system resolution with its audit row in the same transaction, once the
withdrawal leaves the state it reports, so a long but legitimate manual review does not count
toward `alertThreshold` for ever. A close that fails is logged and retried on the next cycle,
and never stops the cycle from filing.

Limits of the dedup:

- A finding is never filed twice for the same withdrawal and kind, open or closed. A withdrawal
  that returns to a state it was already reported in, for example requeued after approval, is
  not reported again.
- A dispatched withdrawal that already holds an `unknown_at_provider` finding sorts with the
  reported rows, so a later `stuck_withdrawal_processing` for it waits for room in the batch.

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
- Rolling deploy: a verdict from an old tag replica has no `reviewRequired`, so the wallet treats
  it as asking for a review. The three new finding kinds come with a migration, and an old
  replica may not serialise them: run the migration and replace every replica that reads findings
  before relying on them.

Known gaps:

- Bonus forfeiture still runs inside the withdraw transaction (`BONUS_LIFECYCLE`).
- The review threshold compares raw amounts across currencies, as before.

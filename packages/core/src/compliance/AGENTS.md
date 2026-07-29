# compliance

Regulatory surface: player limits, KYC verification, geo rules, Responsible Gambling (RG). Headless - the back-office UI lives in the consumer.

## KYC

Submission, vendor/webhook reconciliation, deposit-threshold re-KYC. Vendor-agnostic: real providers bind against `KYC_ADAPTER` / `KYC_STATUS_WRITER` / `KYC_WEBHOOK_VERIFIER` (`contracts/adapters/kyc.ts`; vendor shapes in `docs/adapters/kyc.md`); this repo ships only `MockKycAdapter` (auto-approves). `kyc_verification` is an append-only history. `kycWebhook` is an unauthenticated M2M route verified via `KYC_WEBHOOK_VERIFIER`; `reconcile` applies vendor decisions idempotently. `CumulativeDepositReKycTrigger` (`service/re-kyc-trigger.ts`) is pure, DB-free threshold-band logic.

Invariant: `KYC_STATUS_WRITER` is the SINGLE writer for `player.kycStatus` - pam owns and binds the only implementation; every status change (submit, webhook reconcile, threshold re-KYC, admin override) routes through it so the `compliance.kyc.updated` audit emit can never be skipped. Compliance calls the port, never writes `player` directly.

### Admin KYC actions (resubmit / override / bulk-approve)

All three take a **mandatory, non-empty `reason`**, are guarded by `compliance:override-limit`
(whichever roles a deployment grants that permission - eg Super Admin, Compliance Manager),
and route through `KycVerificationService` (`requestResubmission`/`overrideStatus`/`bulkApprove`
in `service/kyc.service.ts`), which - unlike `submit`/`reconcile` - both inserts a
`kyc_verification` history row (`triggeredBy: 'manual'`, `provider: 'manual'`,
synthetic `referenceId`) AND calls `KYC_STATUS_WRITER.setStatus(..., { source: 'manual' })`
in the SAME transaction, so an admin action leaves the same audit-visible history a
vendor/webhook decision does (`getPlayerKyc` shows it). Idempotent on a repeat call
that resolves to the status the player is already at - no duplicate history row, no
duplicate `compliance.kyc.updated` emit (checked via an upfront `player.kycStatus`
read, not just relying on the writer's own conditional-UPDATE no-op).

That idempotency read is `requirePlayerRowForUpdate`, and its `FOR UPDATE` must run
INSIDE the method's own transaction, never as a separate pre-check select: under READ
COMMITTED a plain read-then-decide lets two concurrent calls for the same player both
pass the check before either commits, double-inserting history. Locking the row first
serializes them - the same reason `WalletService.withdraw` locks the wallet row before
its own idempotency check. This is also what closes the same-userId-twice-in-one-call
race inside `bulkApprove`, since it fans out through `overrideStatus`.

`submit` and `reconcile` write the `kyc_verification` row and call
`KYC_STATUS_WRITER.setStatus` in one transaction for the same reason the admin actions
do: a crash between the two would leave the append-only history and the player's live
status disagreeing.

**`manually_overridden` representation.** The product spec wants both "the operator's
chosen status" and "flagged as manually overridden" out of `overrideKycStatus`, but
`player.kycStatus` is a single enum column - it cannot hold both simultaneously. The
codebase already established the answer before this task: the wallet KYC gate
(`KYC_PASS_STATUSES`) and `pam/tag`'s tag-evaluation service both treat
`manually_overridden` as an approved-equivalent terminal status, kept distinct from a
vendor `approved` for reporting/audit. So `overrideStatus`/`bulkApprove` route an
`approved` choice through `resolveManualStatus`, which rewrites it to
`manually_overridden` before writing; every OTHER choice (`rejected`, `pending`,
`resubmission_requested`, `not_started`) is written verbatim - no ambiguity there, since
only `approved` collides with the vendor-decision meaning. The "this was manual" fact
for every other choice already lives orthogonally in `triggeredBy: 'manual'` +
`source: 'manual'`, so nothing is lost by NOT also overloading the status for them.
`OverrideKycStatusInputSchema`'s `status` field (`KycOverrideStatusSchema`) excludes
`manually_overridden` from the operator-facing choices for this reason - it is a
derived value the service computes, never one an admin types in directly. This applies
uniformly to `bulkApproveKyc` too (each item resolves through the same
`overrideStatus('approved', ...)` call), even though the product brief's literal text
for bulk-approve just says "sets approved" - writing a bare `approved` there would
silently reintroduce the exact ambiguity the override route was designed to avoid.

**Supersedes `playerContract.update`'s old `kycStatus` field.** Before this change, an
admin could also flip `player.kycStatus` via `PATCH /players/{playerId}` (gated by the
same `compliance:override-limit` permission) - but that path took no reason and wrote
no `kyc_verification` history row, a real compliance gap for a regulated action. That
field has been REMOVED from `playerContract.update` (see
`pam/player-management/contract/index.ts`); `overrideKycStatus` is now the only way to
change a player's KYC status by hand. `PlayerService` no longer depends on
`KycStatusWriter` at all.

**Notification (resubmission request).** `requestKycResubmission` and an
`overrideKycStatus` call landing on `resubmission_requested` both emit the same
`compliance.kyc.updated` event (status + source, no new event type needed) - the
`notifications` module subscribes to it (filtered to `status: 'resubmission_requested'`,
`source: 'manual'`) and dispatches the player email + in-app notification through
`JOB_QUEUE` (never inline in the admin request path). Compliance never imports
`notifications` - the domain event is the only coupling. See
`engagement/notifications/AGENTS.md`.

Compliance defines its own `PlayerNotFoundError` (`makeNotFoundError('Player')` in
`service/kyc.service.ts`) for these three routes' existence pre-check - it cannot import
pam's own `PlayerNotFoundError` class (cross-module internals are off-limits), so it
follows the same pattern as `identity`'s and `admin-console`'s independently-defined
`UserNotFoundError`. `bulkApprove` catches per-player errors (not just this one) and
reports `{ userId, success, error }` per item via `mapConcurrent` (bounded fan-out,
never `Promise.all`) rather than letting one bad id fail the whole batch. The per-item
`error` returned on the wire is a fixed string, never the raw exception text - the full
error is logged server-side (with userId) for ops, but a driver/constraint error's exact
text must not reach the admin-facing response body. The input schema caps `userIds` at
100 (`BulkApproveKycInputSchema`) - an unbounded array is a DoS vector - and dedupes
them, since a duplicate id is always a caller bug, never a legitimate "approve twice".
A failed item never reaches `overrideStatus`, so it leaves no `compliance.kyc.updated`
trail of its own - the router additionally records the WHOLE attempted batch as one
`AUDIT_WRITER` entry (`compliance.kyc.bulk_approve`, `after: { reason, results }`) after
`bulkApprove` returns, so an id probe (existing vs not) is still visible in the audit
log even when nothing downstream changed for that id. `requestResubmission` and
`overrideStatus` share their transaction body (insert the manual history row + call
`KYC_STATUS_WRITER.setStatus`) via a private `applyManualDecision` helper - the two
methods differ only in target status, `referenceId` prefix, and whether `decidedAt` is
stamped, extracted so the locking/idempotency rules above cannot diverge between them.

`KYC_ADAPTER`, `KYC_STATUS_WRITER`, `KYC_WEBHOOK_VERIFIER` (all in
`packages/core/src/contracts/adapters/kyc.ts`). `KYC_STATUS_WRITER` is the single writer
for `player.kycStatus` - pam owns it and binds the only implementation; every status
change (submit, webhook reconcile, threshold re-KYC, admin override) routes through it so
the `compliance.kyc.updated` audit emit never gets skipped. Compliance calls the port,
never writes `player` directly. The write path (`PlayerKycStatusWriter.setStatus`) is a
single conditional `UPDATE ... WHERE kyc_status <> $new` (not select-then-update) so two
concurrent callers across ECS instances can't both pass a stale guard and double-emit;
zero matched rows means either "already at target" (no-op) or the player row doesn't
exist yet, which the writer distinguishes with a follow-up existence check and throws
`PlayerNotFoundError` for the latter rather than dropping the decision silently.

`KycAdapter.resolveDecision(referenceId)` is an optional port method: a hosted-session
vendor (eg Didit) implements it to fetch the full decision (status, `documentTypes`,
`decisionReason`) by reference id off the request path; document-forwarding vendors and
`MockKycAdapter` have nothing to resolve and omit it.

The success status is `approved` (`KYC_STATUSES`, `@openora/core/contracts`); `verified`
is a deprecated alias kept additive for the expand/contract migration (rows/instances may
still hold it). Any code comparing a KYC status for the approved state must go through
`normalizeKycStatus` first - never a scattered `=== 'verified' || === 'approved'`. The
`compliance.kyc.updated` payload (v4) also carries `reason` (nullable) and `source`
(`vendor` | `manual` | `webhook` | `reverify`) so the audit trail records why a
transition happened, not just the before/after status. Both ride in the audit record's
`after` (see `audit/plugin.ts`). Since v3, `actorId` is nullable: null marks a
system-driven flip (vendor/webhook/reverify), which the audit writer records as
`actorType: 'system'`.

### Webhook -> job flow (`kyc-decision-sync`)

`kycWebhook` verifies the signature (see Replay protection below) and `parseWebhook`s the
body, then enqueues a `kyc-decision-sync` job and returns 2xx immediately - it never
awaits a vendor call in the request path (Didit's own webhook SLA is ~5s with 2 retries;
the route must not inherit that latency). `idempotencyKey` is a SHA-256 hash of the
verbatim raw delivery bytes (`kyc-decision-sync:<hash>`), never `<referenceId>:<status>`:
the vendor-neutral `KycResult` carries no delivery/event id, so the byte hash is the only
signal that reliably tells "the SAME decision resent" (a retry storm inside the vendor's
own SLA - correctly collapse it) apart from "a genuinely NEW decision that happens to
land on a status seen before" (eg rejected -> approved -> rejected again - must run).
Keying on `referenceId:status` let BullMQ's permanent-by-default `jobId` dedup (a
completed job's id can never be reused unless retention is bounded - see
`bullmq-job-queue.ts`) silently drop the later, real decision forever; the driver now
also bounds `removeOnComplete`/`removeOnFail` as a systemic safety net. `orderingKey:
referenceId`, 5 attempts with exponential backoff. The `kyc-decision-sync` worker
(registered in `plugin.ts`) calls `KycVerificationService.syncDecision`, which resolves
the full decision via `KYC_ADAPTER.resolveDecision` when the bound adapter implements it
(persisting `documentTypes`/`decisionReason` through `reconcile`), or falls back to the
status-only `reconcile` when it doesn't.

A `PlayerNotFoundError` out of `KYC_STATUS_WRITER.setStatus` (the player row is created
lazily and a decision can legitimately arrive first) is left to propagate all the way out
of the worker handler - no try/catch swallows it - so the job queue's `attempts`/`backoff`
retries the decision instead of dropping it.

**Decision monotonicity.** The BullMQ driver ignores `orderingKey` (no ordering groups in
OSS BullMQ), so two decisions for the same reference can run out of arrival order after a
retry. The router stamps `receivedAt` (webhook-arrival wall-clock time) on the job payload
BEFORE enqueue - immune to job-processing reordering - and `KycVerificationService.
reconcile` persists it as `kyc_verification.decisionReceivedAt`, refusing to apply an
incoming decision older than the one already on file for that reference (logs and returns
the current row unchanged; no `KYC_STATUS_WRITER` call, no re-emit). A caller with no
`receivedAt` (a direct `reconcile()`/`syncDecision()` call outside the job path) skips the
guard - always applies, same as before this existed.

### Replay protection (`HmacKycWebhookVerifier`)

A vendor may sign ONLY the body (Didit-style), never a timestamp, so a signed-freshness
check is not available - the signature itself is the only authenticated, replay-detectable
value. The default verifier rejects a signature already accepted within a 10-minute
window (`CACHE` seam, `kyc-webhook-seen:<sha256(signature)>` key with a matching TTL) -
comfortably covers a vendor's own legitimate retry burst while closing most of the
"capture a valid body+signature and resend it later" window. `CACHE` is the same port
already bound cross-instance when `REDIS_URL` is set (ADR-0028), so replay detection
coordinates across replicas with zero extra wiring; the in-process default degrades to
per-instance-only protection. A `CACHE` failure degrades OPEN (accepts, logs a warning)
rather than blocking every webhook on an unrelated infra blip - the signature check
remains the fail-closed primary control. Beyond the 10-minute window, a decision replay
still hits the monotonicity guard above if a newer decision has since landed.

### Device/IP risk signals

The vendor cannot screen device/IP at signup - the signals only exist as part of a
hosted verification session - so screening happens at first KYC instead, via the same
`kyc-decision-sync` flow above. `KycAdapter.resolveRiskSignals(referenceId)` is a second,
independent optional port method (`contracts/adapters/kyc.ts`): a hosted-session vendor
(eg Didit) extracts the vendor-neutral shape `{ vpnOrTorDetected, dataCenterIpDetected,
duplicateDeviceDetected, highRiskCountryDetected, deviceFingerprints }` from its own
session decision; document-forwarding vendors and `MockKycAdapter` omit it.
`KycVerificationService.syncDecision` calls it alongside `resolveDecision` (independently

- an adapter can implement either, both, or neither) and passes the result into the same
  `reconcile` call. `reconcile` persists it on the `kyc_verification` row's `riskSignals`
  jsonb column (nullable, preserved when a later reconcile carries none - same rule as
  `documentTypes`), which `getPlayerKyc` surfaces on `current`/`history` for compliance
  admins. Storage lives on `kyc_verification` rather than a separate table or the `player`
  row: the signals belong to a specific verification session (referenceId), the same
  append-only history that already carries `documentTypes`/`decisionReason` for that
  session, and "must not be silently lost" compliance evidence is exactly what that
  history exists for.

**Auto-tagging rule.** `warrantsHighRiskTag` (`kyc.service.ts`) fires
`compliance.kyc.high_risk_signal_detected` only when `duplicateDeviceDetected` or
`highRiskCountryDetected` is true - never for `vpnOrTorDetected` or
`dataCenterIpDetected` alone or combined. A VPN/Tor exit or a datacenter IP is weak,
common evidence on its own (privacy tooling, corporate proxies, mobile carrier NAT) and
stacking two weak IP-reputation signals doesn't compound into strong evidence without a
base-rate model this platform doesn't have. A duplicate device fingerprint (the same
device already tied to another account) and a high-risk country (an AML/FATF-relevant
jurisdiction flag) are each independently strong, standalone fraud/compliance signals.
`pam/tag` subscribes to the event and applies `high_risk` as a pure label (same
precedent as `advanced_kyc_needed` reacting to `compliance.kyc.reverify_required` below)

- it does not re-derive which signals qualify. The event fires (and is emitted) only
  inside `reconcile`'s non-idempotent branch, so a redelivered no-op `kyc-decision-sync`
  job never double-emits.

### Workflow completeness (per-step checks)

Completeness is ours, quality is theirs. A vendor's session-level `approved` says the
overall workflow finished; it says nothing about whether every expected step (ID check,
liveness, face match, AML, proof of address, ...) individually reached a terminal
successful state. A hosted-session vendor can report `Approved` while one step sits at
`Not Started` or `Expired` (a workflow-graph bug, a skipped branch, a document that
expired mid-review) - this platform must not release withdrawals against that. Compliance
does NOT re-derive the vendor's own judgement calls (document expiry thresholds, face
similarity scores, AML hit relevance) - only whether the vendor itself marked each step
`approved`.

`KycCheckStatus`/`KycCheckResult` (`contracts/adapters/kyc.ts`) are the vendor-neutral
shape: `{ step: string; status: KycCheckStatus }`, where `status` is one of
`not_started | in_progress | in_review | approved | declined | expired | unknown`.
`unknown` covers a vendor status string this platform doesn't recognize - it is never
treated as `approved`, so an unrecognized vendor value fails safe into the manual queue
rather than crashing or silently passing. `KycResult.checks` (optional) carries the full
per-step array for the CURRENT session. Only `undefined` means "this adapter structurally
has no step-level granularity" (document-forwarding vendors, `MockKycAdapter`) - the gate
below is a no-op for that vendor only in that case. A supplied-but-empty `checks: []`
means "zero steps resolved" and is treated as INCOMPLETE, same as any other non-`approved`
entry (`findIncompleteCheck`) - an adapter that has step granularity must never conflate
"nothing to report" with "everything passed".

**Which steps are "expected" is derived from the decision payload itself, never a
separately maintained list.** A hosted-session vendor's workflow graph is edited in the
vendor's own dashboard with no code deploy on this side, so any config mirroring "the
current step list" drifts the moment an operator changes the graph. Didit's session
decision already reports its own `features` array on every call - the definitive,
self-describing list of steps THAT session's workflow actually ran - so
`DiditKycAdapter.resolveDecision` (betfeel `apps/api/src/extensions/didit/`) builds
`checks` from `decision.features` via `resolveKycChecks`/`buildKycChecks`
(`didit-decision-mapper.ts`), never from a hardcoded or platform-config feature list. A
future vendor adapter follows the same rule: derive expected steps from whatever the
vendor's own decision response says applied to that session. Didit is a hosted-session
vendor with a real workflow graph, so it always has step granularity: on an `approved`
decision with a genuinely empty/missing `features` list, `resolveKycChecks` returns a
single `unknown` check rather than `undefined` - `undefined` is reserved for adapters
that structurally cannot report steps at all, which Didit never is. `IP_ANALYSIS` is
excluded from the feature -> check-block table: it is a risk signal (surfaced separately
via `resolveRiskSignals`/`extractKycRiskSignals`), not a pass/fail verification step, and
must never itself downgrade an otherwise-complete approval. Where a check block carries
multiple items (eg two `id_verifications`), `aggregateCheckStatus` reports the worst by
an explicit severity ranking (`declined` > `expired` > `unknown` > `in_review` >
`in_progress` > `not_started` > `approved`), not the first non-`approved` item by array
order - a co-present `declined` must never be hidden behind an earlier, less severe
`in_review`.

`KycVerificationService.reconcile` and `submit` (`kyc.service.ts`) both run the same
completeness gate: when the mapped vendor status is `approved`, the checks THIS CALL is
about to persist - `opts.checks` on `reconcile` (falling back to the existing row's
`checks` when the caller supplies none, so a later checks-less reconcile can never
silently clear an earlier downgrade), or `result.checks` on `submit` for a vendor with an
instant decision - are checked for any non-`approved` entry (`findIncompleteCheck`). When
one is found, the status actually written is `resubmission_requested` instead - the
existing "needs player/operator attention" queue, not a new enum value. The
`decisionReason` column is overwritten to name the incomplete step and its status
(`describeIncompleteCheck`), so `getPlayerKyc` tells an operator WHY a vendor-approved
session landed in the queue instead of a clean `approved`. The `reason` forwarded to
`KYC_STATUS_WRITER.setStatus` (and from there into the `compliance.kyc.updated` audit
event) is ONLY a reason this call itself produced - the gate's `describeIncompleteCheck`
or an explicit `opts.reason` - never a prior reason preserved on the row, so a bare
status reconcile that supplies no reason of its own never re-surfaces stale reviewer text
on an unrelated transition. `syncDecision` passes `decision.checks` through unchanged;
`checks` is absent entirely when the vendor/adapter has no step-level granularity, in
which case the gate never fires (back-compat with every adapter that predates this).

`checks` is persisted on the `kyc_verification` row (nullable jsonb, same
preserved-when-absent rule as `documentTypes`/`riskSignals`) - audit evidence for why a
decision was downgraded, not just the resulting status.

## RG

Write surface (limits incl. a session-time limit, cooling-off 24h-6wk, self-exclusion >=6mo or permanent, server-enforced lift) plus read/monitoring surface (flags, audit-backed history). The session limit reuses `user_limit` polymorphically by `type`: money limits carry `amount` (a `decimal()`), the session-time limit carries `minutes`.

Enforcement depth = block login + revoke all active sessions + refuse the wager itself. The login block alone is NOT sufficient: a launched game's provider token outlives our session and aggregator settlement is inbound, so revoking sessions does not stop a round already in play (ADR-0032). Pending withdrawals are untouched (funds are not locked).

Enforcement crosses the module boundary through two non-sealed ports in `@openora/core/contracts`, both owned + bound by identity. Compliance drives them only - never the identity schema.

- `LOGIN_ENFORCEMENT` (push): `block` sets `user.rgBlocked`/`rgBlockedUntil` and revokes all sessions, `unblock` clears them.
- `PLAY_ELIGIBILITY` (read): gaming's `startRound` and wallet's `debit` (only `type: 'bet'`) refuse a restricted player, fail-closed, unknown user included. `win`/`loss` stay ungated - they settle an already-staked round rather than opening a new one.

Cooling-off auto-expires by the `now >= rgBlockedUntil` compare - there is no unblock job. An admin can also end one early via `liftCoolingOff` (mandatory reason, NO confirm gate - unlike self-exclusion, a cooling-off is a support action that must stay reversible); `syncEnforcement` then recomputes and keeps the block if a self-exclusion is still active.

Monitoring is queue-based: `wallet.deposit.completed` / `gaming.round.ended` / `rg.exclusion.login_blocked` enqueue per-player `rg-eval` jobs (idempotencyKey + orderingKey:userId) off the hot path; a worker upserts/clears `rg_flag` rows at the 80% band; a recurring `rg-monitor` job (everyMs 60_000 + cron for a durable overlay) raises session-time flags. Pure eval helpers (`periodWindow`/`thresholdPct`/`isAtThreshold`) live in `service/rg-eval.ts`, DB-free. Cross-domain reads go through `/schema` subpaths only (wallet, casino/gaming for spend aggregation, pam/identity `session` for the sweep).
RG change history / activity log / CSV = the audit module filtered by `actionPrefix: 'rg.'` (`resourceId` = subject player) - no new history table.

## Don't

- Bind the sealed RG / national-register tokens (GamStop is out of scope, stays UNBOUND).
- Write `player` directly - go through `KYC_STATUS_WRITER` / `LOGIN_ENFORCEMENT`.

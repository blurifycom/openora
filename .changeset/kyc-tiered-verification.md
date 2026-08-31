---
'@openora/core': major
---

KYC verification is now tiered: `basic` and `advanced` are tracked as independent `kyc_verification` histories, each with its own current status. `player.kycStatus` (and therefore the withdrawal gate) still tracks basic tier only; advanced tier is a separate signal for operators to build on.

Upgrading a consumer:

- **`submitKyc` (`POST /compliance/kyc`) now requires a `tier` field** on the input alongside `documents`.
- **`PlayerKycView` (`getPlayerKyc`/admin) reshaped** from flat `{ current, history }` to `{ basic: { current, history }, advanced: { current, history } }`.
- **`getMyKyc` (`GET /compliance/kyc/me`) now returns a trimmed `PlayerKycSummaryView`** - `{ basic, advanced }` of `{ tier, status, documentTypes, submittedAt, decidedAt, createdAt, updatedAt }` only. `riskSignals`, `checks`, `decisionReason`, `provider`, and `referenceId` (fraud-detection internals) stay admin-only on `getPlayerKyc`.
- **`compliance.kyc.updated` now carries a `tier` field** and fires for both tiers. Consumers subscribing to this event that only care about the withdrawal-gating (basic) flow should filter on `tier === 'basic'`, same as this PR's own `tag-evaluation`, realtime, and notification subscribers do. `tier` defaults to `'basic'` when absent on `compliance.kyc.updated`/`.submitted`/`.reverify_required`/`.high_risk_signal_detected`, so an older payload still queued at deploy time parses instead of being dropped.
- **`KycAdapter.submit`/`getStatus` take a required third `tier: KycTier` parameter.** Any overlay implementing `KycAdapter` must route `tier` to the vendor's workflow selection (or ignore it, for a single-workflow vendor).
- **`KycStatusWriter.setStatus` now returns `Promise<KycStatusTransition | null>`** instead of `Promise<void>`. An overlay rebinding `KYC_STATUS_WRITER` must return the transition (`{ playerId, previousStatus }`, or `null` when the status didn't change) - compliance's audit trail (`compliance.kyc.updated`'s `previousStatus`) depends on it for Basic.
- **`KycResult` gained an optional `tier` field.** An adapter that can attribute a webhook/`resolveDecision` decision to one tier should set it, so `reconcile` scopes the write to that tier's row instead of fanning the decision out across every row sharing the vendor reference (the pre-existing "shared vendor workflow" behavior, kept for adapters that omit it). `reconcile` also now fails closed - throws rather than writes - if rows sharing one `referenceId` ever belong to different players, or if a webhook-supplied `tier` disagrees with `resolveDecision`'s.

The `kyc_verification` table gets a new composite unique index on `(user_id, reference_id, tier)`, replacing the old `reference_id`-only unique index in the same migration (0006). This is a contract-then-expand-style rename with no bridge migration: during a rolling deploy, a pod still running the pre-tier build's `onConflictDoUpdate({ target: referenceId })` will fail its KYC submit inserts once 0006 has run and before it's replaced. Sequence the deploy so this migration runs only after every pod is on the new build - do not let it run mid-rollout.

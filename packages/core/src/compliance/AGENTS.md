# compliance

Regulatory surface: player limits, KYC verification, geo rules, Responsible Gambling (RG). Headless - the back-office UI lives in the consumer.

## KYC

Submission, vendor/webhook reconciliation, deposit-threshold re-KYC. Vendor-agnostic: real providers bind against `KYC_ADAPTER` / `KYC_STATUS_WRITER` / `KYC_WEBHOOK_VERIFIER` (`contracts/adapters/kyc.ts`; vendor shapes in `docs/adapters/kyc.md`); this repo ships only `MockKycAdapter` (auto-approves). `kyc_verification` is an append-only history. `kycWebhook` is an unauthenticated M2M route verified via `KYC_WEBHOOK_VERIFIER`; `reconcile` applies vendor decisions idempotently. `CumulativeDepositReKycTrigger` (`service/re-kyc-trigger.ts`) is pure, DB-free threshold-band logic.

Invariant: `KYC_STATUS_WRITER` is the SINGLE writer for `player.kycStatus` - pam owns and binds the only implementation; every status change (submit, webhook reconcile, threshold re-KYC, admin override) routes through it so the `compliance.kyc.updated` audit emit can never be skipped. Compliance calls the port, never writes `player` directly.

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

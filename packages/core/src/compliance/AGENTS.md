# Compliance Module

Regulatory surface: player limits, KYC verification, geo rules, and Responsible
Gambling (RG). Headless - the back-office UI lives in the consumer.

## KYC

Player identity verification: submission, vendor/webhook reconciliation, and
deposit-threshold re-KYC. Vendor-agnostic - real providers (SumSub-style
document-forwarding, hosted-session vendors) bind against the adapter ports in
`docs/adapters/kyc.md`; this repo ships only `MockKycAdapter` (auto-approves).

### Layout (KYC pieces)

| Layer    | File                        | Holds                                                                                                                                                                                |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| schema   | `schema/index.ts`           | `kyc_verification` table (append-only history: `referenceId`, `status`, `documentTypes`, `triggeredBy`, `decidedAt`).                                                                |
| contract | `contract/index.ts`         | `getPlayerKyc`, `submitKyc`, `kycWebhook` routes + `KycVerificationSchema`/`SubmitKycOutputSchema` (extends the record with an optional `verificationUrl`).                          |
| service  | `service/kyc.service.ts`    | `KycVerificationService`: `submit` (calls `KYC_ADAPTER`, inserts a record), `reconcile` (idempotent vendor-decision apply), `getForPlayer`, `handleDeposit` (threshold re-KYC hook). |
| service  | `service/re-kyc-trigger.ts` | `ReKycTrigger` interface + `CumulativeDepositReKycTrigger` (pure, DB-free threshold-band logic).                                                                                     |
| router   | `router/index.ts`           | `submitKyc` (player-scoped), `getPlayerKyc` (admin-guarded), `kycWebhook` (unauthenticated M2M, verified via `KYC_WEBHOOK_VERIFIER`).                                                |

### oRPC routes

| Procedure                 | Method | Path                               | Guard                        |
| ------------------------- | ------ | ---------------------------------- | ---------------------------- |
| `compliance.submitKyc`    | POST   | `/compliance/kyc`                  | authenticated player         |
| `compliance.getPlayerKyc` | GET    | `/compliance/players/{userId}/kyc` | `compliance:view`            |
| `compliance.kycWebhook`   | POST   | `/compliance/kyc/webhook`          | `KYC_WEBHOOK_VERIFIER` (M2M) |

### Adapter ports

`KYC_ADAPTER`, `KYC_STATUS_WRITER`, `KYC_WEBHOOK_VERIFIER` (all in
`packages/core/src/contracts/adapters/kyc.ts`). `KYC_STATUS_WRITER` is the single writer
for `player.kycStatus` - pam owns it and binds the only implementation; every status
change (submit, webhook reconcile, threshold re-KYC, admin override) routes through it so
the `compliance.kyc.updated` audit emit never gets skipped. Compliance calls the port,
never writes `player` directly.

## Responsible Gambling (RG)

A write surface (limits, cooling-off, self-exclusion, lift) plus a read/monitoring surface
(flags, audit-backed history). Scope: player limits (incl. a session-time limit),
cooling-off (24h-6wk), self-exclusion (>=6mo or permanent), server-enforced
self-exclusion lift, queue-based monitoring flags, audit-backed history/activity/CSV,
and email on every admin RG action.

Enforcement depth = block login + revoke all active sessions. No per-transaction
gating - the login block + session revoke makes betting impossible transitively.
Pending withdrawals are untouched (funds are not locked).

### Layout (RG pieces)

| Layer    | File                                   | Holds                                                                                                                                                                                                                              |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema   | `schema/index.ts`                      | `rg_exclusion` (`isPermanent`), `rg_flag` tables + pgEnums. Session limit reuses `user_limit` (`amount`/`minutes` polymorphic by `type` - money limits carry `amount` as a `decimal()`, the session-time limit carries `minutes`). |
| contract | `contract/rg.ts`, `contract/limits.ts` | RG route contract + req/res schemas; shared `LimitSchema` leaf.                                                                                                                                                                    |
| service  | `service/rg.service.ts`                | limit set, cooling-off, self-exclusion, lift, `getRgSection`.                                                                                                                                                                      |
| service  | `service/rg-monitoring.service.ts`     | `evaluateUser` (limit-threshold + login flags), `sweep` (session-time), `listFlags`.                                                                                                                                               |
| service  | `service/rg-eval.ts`                   | pure `periodWindow` / `thresholdPct` / `isAtThreshold` (DB-free).                                                                                                                                                                  |
| router   | `router/index.ts`                      | RG routes, admin-guarded.                                                                                                                                                                                                          |
| plugin   | `plugin.ts`                            | event subscriptions -> `rg-eval` jobs, `rg-eval`/`rg-monitor` workers, `rg-monitor` schedule.                                                                                                                                      |

### oRPC routes

| Procedure                          | Method | Path                                               | Guard                  |
| ---------------------------------- | ------ | -------------------------------------------------- | ---------------------- |
| `compliance.setPlayerLimit`        | PUT    | `/compliance/players/{userId}/limits`              | `compliance:manage-rg` |
| `compliance.activateCoolingOff`    | POST   | `/compliance/players/{userId}/cooling-off`         | `compliance:manage-rg` |
| `compliance.activateSelfExclusion` | POST   | `/compliance/players/{userId}/self-exclusion`      | `compliance:manage-rg` |
| `compliance.liftSelfExclusion`     | POST   | `/compliance/players/{userId}/self-exclusion/lift` | `compliance:manage-rg` |
| `compliance.getRgSection`          | GET    | `/compliance/players/{userId}/rg`                  | `compliance:view`      |
| `compliance.listRgFlags`           | GET    | `/compliance/rg-flags`                             | `compliance:view`      |

RG change history / activity log / CSV = the audit module: filter by `actionPrefix: 'rg.'`
(`resourceId` = subject player for per-player history). No new history table.

### Cross-boundary login enforcement

`LOGIN_ENFORCEMENT` (a non-sealed push port in `@openora/core/contracts`) is owned +
bound by identity (`pam/identity/service/login-enforcement.service.ts`). `block` sets
`user.rgBlocked` / `rgBlockedUntil` and revokes all sessions; `unblock` clears them.
Compliance drives it through the port only - never the identity schema. The identity
login gate reads the two columns and returns FORBIDDEN (+ emits `rg.exclusion.login_blocked`)
while blocked and not expired; cooling-off auto-expires by the `now >= rgBlockedUntil`
compare - no unblock job.

### Monitoring (queue-based)

`wallet.deposit.completed` / `gaming.round.ended` /
`rg.exclusion.login_blocked` enqueue per-player `rg-eval` jobs (idempotencyKey +
orderingKey:userId) off the hot path. A worker upserts/clears `rg_flag` rows at the 80%
band; a recurring `rg-monitor` job (everyMs 60_000 + cron for a durable overlay) raises
session-time flags. `listRgFlags` is a cheap indexed read enriched via `ADMIN_USER_DIRECTORY`.

Cross-domain reads (`/schema` subpaths only): wallet, casino/gaming (spend
aggregation), pam/identity (`session` for the sweep).

### Events (audited)

`rg.limit.set` (v2 - `amount` (decimal string)/`minutes` polymorphic by limit `type`, plus
`previousAmount`/`previousMinutes`), `rg.cooling_off.activated` (v1),
`rg.self_exclusion.activated` (v2 - `isPermanent`), `rg.self_exclusion.lifted`
(admin actor, subject player), `rg.exclusion.login_blocked` (system actor,
`result:'failure'`). Declared in `domainEventSchemas`; audited via the subscription +
`mapEventToRecord` branch in `audit/plugin.ts`.

## Don't

- Bind the sealed RG / national-register tokens (GamStop is out of scope, stays UNBOUND).
- Import a sibling's internals - use the command port / event / `/schema` subpath only.
- Hand-edit generated migrations.

# wallet

User balances, deposits, withdrawals. One wallet per user. Default `PAYMENT_ADAPTER` binding is `MockPaymentAdapter` (always returns terminal `completed`). Routes, tables (`wallet`, `wallet_transaction`, `auto_withdrawal_rule`, `wallet_deposit_address`), events (`wallet.*`, v2): `contract/`, `schema/index.ts`, `domainEventSchemas`.

## Money model (ADR-0029)

Money columns are `decimal({ precision: 18, scale: 8 })` - Postgres `NUMERIC`, a decimal STRING in TS, never a float, never a scaled integer. Scale 8 covers fiat (2dp) and crypto (BTC-level 8dp) without a per-asset rescale table. Balance mutations run as SQL numeric arithmetic (`` sql`${wallet.balance} + ${amount}::numeric` ``), never JS math. `moneyToNumber()` is the ONE sanctioned decimal->number conversion point, for heuristics only - never for a ledger write.

## Payment seam

`PAYMENT_ADAPTER` covers two vendor shapes (`docs/adapters/payment.md`): a synchronous PSP (`processDeposit`/`processWithdrawal` return an already-terminal status) and an address-based/async custody vendor (optional `issueDepositAddress` + `parseWebhook`, driving inbound deposits and delayed settlement through `POST /wallet/webhook`). Implement under `adapters/<vendor>/` and rebind in an overlay loading after wallet - last registration wins. `PAYMENT_WEBHOOK_VERIFIER` default (`HmacPaymentWebhookVerifier`) checks HMAC-SHA256 over the raw body against `x-payment-signature` (case-insensitive, `sha256=` prefix tolerated, timing-safe), keyed by `PAYMENT_WEBHOOK_SECRET`; fails closed on a missing secret, header, or raw body.

## Withdrawal lifecycle

Player `withdraw` HOLDS funds (balance debited at request time) -> `pending` -> admin approves (`processing`, sent to the rail - derived from currency: `BTC`/`ETH`/`USDT` -> `fireblocks`, else `psp`) or rejects with a mandatory reason (`rejected`, funds returned) -> `completed`/`failed`. A synchronous PSP finalizes immediately in `settleApproved` (PSP call outside the tx; refund on failure). An async vendor returns a non-terminal status - the row stays `processing` and the webhook-driven `reconcileWithdrawalStatus` does the eventual transition; it is idempotent and no-ops on any row not currently `processing`.

KYC gate: when `platformConfig.kyc.gateWithdrawals` is true, `withdraw()` fails closed unless the player's status is `verified`/`manually_overridden` (`KycRequiredError` -> CONFLICT), read via the existing `ADMIN_USER_DIRECTORY.lookupPlayers` port - no new cross-domain coupling. Off by default.

Queue `riskTags` are DB-backed heuristics, not a risk engine: `large_amount` (>= 5000) and `high_frequency` (>= 3 withdrawals per wallet in trailing 24h, one batched query).

## Auto-approval (off by default)

After the hold commits, `maybeAutoApprove` decides WHO approves - system or manual queue - never whether the request succeeds. Strictly fail-closed: it NEVER throws out of `withdraw()`; any error or ambiguous branch leaves the row `pending`.

- Gates (ALL must hold): `autoWithdrawal.enabled`; a resolved positive threshold for the withdrawal's RAIL (per-player `auto_withdrawal_rule` wins over the global `fiatThreshold`/`cryptoThreshold`) with `amount <= threshold`; KYC status in the pass-set INDEPENDENT of `kyc.gateWithdrawals` (missing directory/summary => pending); no active tag intersecting `excludeRiskFlags` (via `PLAYER_TAGS`; port unbound while flags are configured => pending); neither risk heuristic; trailing-24h `dailyCapAmount`/`dailyCapCount` not exceeded.
- Only the daily-cap check runs under the per-user advisory lock (atomic with the `processing` flip); the other gates run before it.
- System-actor marker: `reviewedBy = null`, `reviewReason = 'auto-approved'`. Reuses `flipToProcessing`/`settleApproved` - the same two-phase sequence as manual approve.
- Every auto-approval writes an `AUDIT_WRITER` entry (`actorType: 'system'`) capturing the full rationale BEFORE the PSP call, so the AML/SAR trail survives a PSP failure.
- Crypto uses the SAME mechanism and gates as fiat (BF-211), safe because `cryptoThreshold` is absent by default - unset/zero resolves to "never auto-approve", so an upgrade never silently activates it. The per-player rule is a single global column, not rail-aware.

## Idempotency and races

- Client-supplied `idempotencyKey` (optional uuid) on deposit/withdraw: partial unique index on `(wallet_id, idempotency_key)`. A matching key returns the ORIGINAL stored transaction (same shape, no second insert, no re-emitted event); a reused key with a DIFFERENT amount -> `IdempotencyKeyReuseError` (CONFLICT).
- The insert is `onConflictDoNothing()` - a concurrent loser no-ops (never aborts the tx) and re-reads the winner's committed row.
- `deposit` pre-checks replay BEFORE the PSP call so a client retry never re-charges. That pre-check is NOT race-safe by design - two concurrent first attempts can both reach the PSP, but the ledger guard still never double-credits.
- Webhook deposit credits are idempotent on the vendor `externalId` (`providerRefId`, partial UNIQUE + `onConflictDoNothing` + re-read - a DB guard, per the money-critical-path convention). An unknown deposit address logs and no-ops - never throws past the webhook boundary. `wallet.deposit.completed` emits only on the actual credit, never on a replay.
- Deposit addresses are get-or-create, unique on `(userId, currency)`; `DepositAddressUnsupportedError` (CONFLICT) when the bound adapter lacks `issueDepositAddress`.
- Rate limiting: deposit/withdraw consume 30/min per user (`RATE_LIMITER`, key `wallet-mutation:<userId>`) before any work -> 429 with `retryAfterMs`. Guards a runaway client, not fraud - idempotency + the ledger guard cover correctness.

## WALLET_COMMANDS (provided port)

Other modules move money WITHIN their own db transaction via `WALLET_COMMANDS.debit/credit(tx, { userId, amount, type })` - never by importing wallet tables (ADR-0010/0016). Both write a `completed` ledger row (internal settlement) so gameplay shows in transaction history. Both reject a non-positive `amount` EXCEPT `type: 'loss'`, which is informational: the stake already left at `bet` time, so a loss writes a 0-amount row and never touches the balance. `debit` returns `{ ok: false, available }` on a shortfall (guarded conditional UPDATE, concurrency-safe); `credit` fails closed on a missing wallet rather than creating one.

## Events note

`wallet.withdrawal.failed` is emitted only when `adminId` is set (manual/auto-approve settlement); a webhook-driven failure refunds and marks `failed` but has no admin to attribute, so it skips the event. The notifications module subscribes to `approved`/`rejected` to notify the player.

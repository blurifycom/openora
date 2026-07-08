# Wallet Module - AGENTS.md

## What this module does

Manages user balances, deposits, and withdrawals. Ships with `MockPaymentAdapter` as the default `PAYMENT_ADAPTER` binding - a synthetic PSP that returns `{ externalId, status: 'completed' }`. Emits domain events on completed transactions. Every user gets one wallet per system; money columns are Drizzle `decimal(...)` (strings in TS) to avoid floating-point drift - read with `Number(record.balance)`, write as a string (e.g. `'0'`).

Withdrawals run through a back-office approval queue: a player `withdraw` HOLDS funds (balance debited at request time) and creates a `pending` transaction. A Payments Manager approves (status -> `processing`, sent to the PSP/Fireblocks rail) or rejects with a mandatory reason (status -> `rejected`, held funds returned). Status lifecycle: `pending` -> `processing` -> `completed`; reject -> `rejected`. Rail is derived from the currency (`BTC`/`ETH`/`USDT` -> `fireblocks`, else `psp`).

## Routes

| Method | Path                                       | Auth                         | Description                                           |
| ------ | ------------------------------------------ | ---------------------------- | ----------------------------------------------------- |
| GET    | /wallet/balance                            | player                       | Returns balance + currency                            |
| POST   | /wallet/deposit                            | player                       | Credit funds, emit domain event                       |
| POST   | /wallet/withdraw                           | player                       | Hold funds, create a `pending` withdrawal             |
| GET    | /wallet/transactions                       | player                       | Last 100 transactions for user                        |
| GET    | /wallet/transactions/{userId}              | admin `transaction:view`     | Backoffice: any player's transaction ledger           |
| GET    | /wallet/withdrawals                        | admin `withdrawal:view`      | Filterable, paginated withdrawal review queue         |
| POST   | /wallet/withdrawals/{withdrawalId}/approve | admin `withdrawal:approve`   | Approve -> `processing`, send to PSP/Fireblocks       |
| POST   | /wallet/withdrawals/{withdrawalId}/reject  | admin `withdrawal:reject`    | Reject (mandatory reason) -> `rejected`, return funds |
| PUT    | /wallet/auto-withdrawal-rules/{userId}     | admin `withdrawal:auto-rule` | Upsert a per-player auto-withdrawal threshold         |
| GET    | /wallet/auto-withdrawal-rules/{userId}     | admin `withdrawal:auto-rule` | Read a player's auto-withdrawal rule (or null)        |
| DELETE | /wallet/auto-withdrawal-rules/{userId}     | admin `withdrawal:auto-rule` | Remove a player's auto-withdrawal rule                |

Player routes require an authenticated caller (verified better-auth session via `getUserId`, ADR-0019). The `withdrawals.*` admin routes call `adminGuard.assert(context, 'withdrawal', '...')` as the first line; the queue lists username + KYC status via the `ADMIN_USER_DIRECTORY.lookupPlayers` port (never reading the player/profile tables directly). Queue filters: `status` (omit for all statuses, not pending-only), `currency`, `rail`, `minAmount`/`maxAmount`, `kycStatus`, `dateFrom`/`dateTo`, plus `page`/`limit`. `riskTags` are DB-backed heuristics (not a risk engine): `large_amount` (amount >= 5000) and `high_frequency` (>= 3 withdrawals for the wallet in the trailing 24h, one batched grouped-count query).

KYC withdrawal gate: when `platformConfig.kyc.gateWithdrawals` is true, `withdraw()` fails closed unless the player's KYC status is in the pass-set (`verified` or `manually_overridden`), throwing `KycRequiredError` (maps to CONFLICT). The status is read through the existing `ADMIN_USER_DIRECTORY.lookupPlayers` port - no new cross-domain coupling. Off by default.

Auto-withdrawal: after the hold commits, `withdraw()` runs a strictly fail-closed evaluator (`maybeAutoApprove`) that decides WHO approves the withdrawal - the system or the manual queue - never whether the request itself succeeds. It NEVER throws out of `withdraw()`; any error or ambiguous branch leaves the row `pending`. On eligibility it reuses `flipToProcessing`/`settleApproved` directly (the same two-phase sequence the manual approve uses: `processing` commit -> PSP call outside the tx -> `completed`, or refund on PSP failure), with `reviewedBy = null` and `reviewReason = 'auto-approved'` as the system-actor marker. Only the daily-cap check runs under the per-user advisory lock (atomic with the `processing` flip); threshold/KYC/risk/velocity gates run before the lock. All gates must hold: `platformConfig.autoWithdrawal.enabled`; rail is `fiat` (crypto is a hard stop - irreversible + Travel-Rule/AML, never auto-approved and never even KYC/risk-resolved); a resolved positive threshold (per-player `auto_withdrawal_rule` wins over the global `autoWithdrawal.fiatThreshold`) with `amount <= threshold`; KYC status in the pass-set INDEPENDENT of `kyc.gateWithdrawals` (missing directory/summary => pending); no active tag intersecting `autoWithdrawal.excludeRiskFlags` (resolved via the `PLAYER_TAGS` port - unbound while flags are configured => pending); no `large_amount`/`high_frequency` heuristic; and the trailing-24h auto-approved `dailyCapAmount`/`dailyCapCount` not exceeded. Every auto-approval writes an `AUDIT_WRITER` entry (`actorType: 'system'`, `action: 'wallet.withdrawal.auto_approved'`) capturing the full rationale (threshold + source, KYC status, risk tags evaluated, caps used) BEFORE the PSP call, so the AML/SAR trail survives a PSP failure. Rule set/delete write `wallet.auto_withdrawal_rule.set`/`.deleted` admin audit entries. Off by default.

Client-supplied idempotency: `deposit` and `withdraw` accept an optional `idempotencyKey` (uuid). `wallet_transaction.idempotency_key` carries a partial unique index scoped to `(wallet_id, idempotency_key)` - a wallet is 1:1 with its user, so this is equivalent to scoping on userId. A matching key returns the ORIGINAL stored transaction (same response shape, no second insert, no re-emitted domain event) - a REUSED key with a DIFFERENT amount is rejected as `IdempotencyKeyReuseError` (CONFLICT) instead of silently replaying the wrong result. The insert uses `onConflictDoNothing()` (unqualified - the table's only unique index is the partial idempotency one); a concurrent race on the index makes the loser's insert a no-op (never aborts the transaction) and it re-reads the winner's already-committed row instead of erroring. No key = unchanged behavior (plain insert, no dedup).

`deposit` checks for a replay BEFORE calling the PSP (a plain pre-transaction read) so the common retry case (client resends after a timeout) never re-charges. This pre-check is NOT itself race-safe: two concurrent first-attempts for the same brand-new key can both miss it and both reach the PSP - that narrow window is accepted (the ledger write itself still never double-credits, via the `onConflictDoNothing` guard above).

Rate limiting: `deposit` and `withdraw` consume a per-user budget (30/min, keyed `wallet-mutation:<userId>`) via the `RATE_LIMITER` port before doing any work - exceeding it throws a 429 (`TOO_MANY_REQUESTS`) carrying `retryAfterMs`. This guards a runaway client, not fraud (idempotency + the ledger guard cover correctness); an overlay rebinds `RATE_LIMITER` to a Redis backend for cross-replica coordination.

## Extension points

- **Ports**: `PaymentAdapter` lives in `@openora/core/contracts` and is passed into `WalletService` (the constructor takes a `PaymentAdapter`; `plugin.ts` resolves `PAYMENT_ADAPTER` from the container). The default binding is `MockPaymentAdapter` (bound in `src/plugin.ts`). Implement it for a real PSP and override the binding via an overlay plugin.
- **Events emitted**:
  - `wallet.deposit.completed` - `{ userId, amount, currency, transactionId }`
  - `wallet.withdrawal.requested` - `{ userId, amount, currency, transactionId }` (player held funds, status `pending`)
  - `wallet.withdrawal.approved` - `{ userId, amount, currency, transactionId, adminId }` (status `processing`, sent to PSP)
  - `wallet.withdrawal.rejected` - `{ userId, amount, currency, transactionId, adminId, reason }` (held funds returned, status `rejected`)
  - `wallet.withdrawal.completed` - `{ userId, amount, currency, transactionId }` (PSP confirmed, status `completed`)
  - `wallet.withdrawal.failed` - `{ userId, amount, currency, transactionId, adminId }` (PSP rejected; held funds returned, status `failed`)
  - All are recorded by the `audit` add-on (`SUBSCRIBED_TOPICS`); the `notifications` add-on subscribes to `approved`/`rejected` to notify the player.
- **Ports consumed**: `ADMIN_USER_DIRECTORY` (`lookupPlayers` for queue enrichment + auto-approval KYC), `ADMIN_GUARD` (admin route authz), `PLAYER_TAGS` (optional; auto-approval risk-flag exclusion, bound by the `tag` module), `AUDIT_WRITER` (required; auto-approval + rule-change audit trail - the module `dependsOn: ['identity', 'tag', 'audit']`).
- **Ports provided**: `WALLET_COMMANDS` (`WalletCommandsService`) - other modules move money in the wallet WITHIN their own db transaction, without importing wallet tables (ADR-0010/0016). `debit(tx, { userId, amount, type })` and `credit(tx, { userId, amount, type })` both write a `completed` `wallet_transaction` ledger row (internal settlement, no provider ref) so gameplay shows in transaction history. `type` is a `WalletTransactionType` (`bet`/`win`/`loss`/`bonus`/`tip`/...). Both reject a non-positive `amount` - EXCEPT `type: 'loss'`, which is informational: the stake already left the wallet at `bet` time, so a loss writes a 0-amount row and never touches the balance. `debit` returns `{ ok: false, available }` on a shortfall (guarded conditional UPDATE, concurrency-safe); `credit` fails closed with `{ ok: false, reason: 'wallet not found' }` rather than creating a wallet.
- **Routes**: `src/router/index.ts`
- **UI slots**: none yet

## Ports

`PaymentAdapter` (symbol `PAYMENT_ADAPTER`, from `@openora/core/contracts`) - the swap seam for a real PSP. `WalletService` injects it and calls it on every money movement: `deposit()` calls `processDeposit(amount, currency, metadata)` BEFORE crediting the balance, and `withdraw()` calls `processWithdrawal(...)` after the balance check and before debiting. The returned `externalId` is stored in the transaction's `metadata` column (JSON, alongside `provider`). The default binding is `MockPaymentAdapter` (returns `{ externalId, status: 'completed' }`).

To use a real PSP, implement `PaymentAdapter` under `adapters/<vendor>/` and bind it in an overlay plugin that loads AFTER the wallet module in `extensions.config.ts` - last registration to the `PAYMENT_ADAPTER` token wins, so the overlay's binding overrides `MockPaymentAdapter` with no fork:

```ts
ctx.provide(PAYMENT_ADAPTER, () => new StripePaymentAdapter());
```

## Do

- Add business logic to `service/wallet.service.ts` (inject `DrizzleService` from `@openora/core/server`; query via `this.drizzle.db.select().from(wallet).where(eq(...))`)
- Add or edit `pgTable` defs in `src/schema/index.ts`, then run `pnpm regen`
- Implement `PaymentAdapter` in `adapters/<vendor>/` for real payment processing
- Emit cross-module events via `EventBus` - never import other modules directly

## Don't

- Import from other modules directly
- Throw framework HTTP errors from services - throw domain errors instead
- Edit the generated migrations under the module's `drizzle/migrations/` by hand - the source of truth is `src/schema/index.ts`
- Use floating-point for money calculations - money columns are `decimal(...)` (strings); read with `Number(record.balance)`, write as a string
- Add inline Zod schemas in the router - all schemas live in `schemas/` or the contract

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=wallet` shows the new/changed route(s) (e.g. `wallet.deposit`).
- No `boundaries/dependencies` lint errors (no cross-module code imports; read other domains' tables only via the `@openora/core/<domain>/schema` subpath).
- If you changed the `PaymentAdapter` contract, `pnpm regen` then check `docs/catalog.json` shows the `PAYMENT_ADAPTER` seam still wired.
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.

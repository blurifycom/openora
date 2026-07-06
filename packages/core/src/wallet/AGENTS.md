# Wallet Module - AGENTS.md

## What this module does

Manages user balances, deposits, and withdrawals. Ships with `MockPaymentAdapter` as the default `PAYMENT_ADAPTER` binding - a synthetic PSP that returns `{ externalId, status: 'completed' }`. Emits domain events on completed transactions. Every user gets one wallet per system; money columns are Drizzle `decimal(...)` (strings in TS) to avoid floating-point drift - read with `Number(record.balance)`, write as a string (e.g. `'0'`).

Withdrawals run through a back-office approval queue (ABC-210): a player `withdraw` HOLDS funds (balance debited at request time) and creates a `pending` transaction. A Payments Manager approves (status -> `processing`, sent to the PSP/Fireblocks rail) or rejects with a mandatory reason (status -> `rejected`, held funds returned). Status lifecycle: `pending` -> `processing` -> `completed`; reject -> `rejected`. Rail is derived from the currency (`BTC`/`ETH`/`USDT` -> `fireblocks`, else `psp`).

## Routes

| Method | Path                                       | Auth                       | Description                                           |
| ------ | ------------------------------------------ | -------------------------- | ----------------------------------------------------- |
| GET    | /wallet/balance                            | player                     | Returns balance + currency                            |
| POST   | /wallet/deposit                            | player                     | Credit funds, emit domain event                       |
| POST   | /wallet/withdraw                           | player                     | Hold funds, create a `pending` withdrawal             |
| GET    | /wallet/transactions                       | player                     | Last 100 transactions for user                        |
| GET    | /wallet/withdrawals                        | admin `withdrawal:view`    | Filterable, paginated withdrawal review queue         |
| POST   | /wallet/withdrawals/{withdrawalId}/approve | admin `withdrawal:approve` | Approve -> `processing`, send to PSP/Fireblocks       |
| POST   | /wallet/withdrawals/{withdrawalId}/reject  | admin `withdrawal:reject`  | Reject (mandatory reason) -> `rejected`, return funds |

Player routes require an authenticated caller (verified better-auth session via `getUserId`, ADR-0019). The `withdrawals.*` admin routes call `adminGuard.assert(context, 'withdrawal', '...')` as the first line; the queue lists username + KYC status via the `ADMIN_USER_DIRECTORY.lookupPlayers` port (never reading the player/profile tables directly). Queue filters: `status` (omit for all statuses, not pending-only), `currency`, `rail`, `minAmount`/`maxAmount`, `kycStatus`, `dateFrom`/`dateTo`, plus `page`/`limit`. `riskTags` are DB-backed heuristics (not a risk engine): `large_amount` (amount >= 5000) and `high_frequency` (>= 3 withdrawals for the wallet in the trailing 24h, one batched grouped-count query).

KYC withdrawal gate: when `platformConfig.kyc.gateWithdrawals` is true, `withdraw()` fails closed unless the player's KYC status is in the pass-set (`verified` or `manually_overridden`), throwing `KycRequiredError` (maps to CONFLICT). The status is read through the existing `ADMIN_USER_DIRECTORY.lookupPlayers` port - no new cross-domain coupling. Off by default.

## Extension points

- **Ports**: `PaymentAdapter` lives in `@blurifycom/adapters` and is passed into `WalletService` (the constructor takes a `PaymentAdapter`; `plugin.ts` resolves `PAYMENT_ADAPTER` from the container). The default binding is `MockPaymentAdapter` (bound in `src/plugin.ts`). Implement it for a real PSP and override the binding via an overlay plugin.
- **Events emitted**:
  - `wallet.deposit.completed` - `{ userId, amount, currency, transactionId }`
  - `wallet.withdrawal.requested` - `{ userId, amount, currency, transactionId }` (player held funds, status `pending`)
  - `wallet.withdrawal.approved` - `{ userId, amount, currency, transactionId, adminId }` (status `processing`, sent to PSP)
  - `wallet.withdrawal.rejected` - `{ userId, amount, currency, transactionId, adminId, reason }` (held funds returned, status `rejected`)
  - `wallet.withdrawal.completed` - `{ userId, amount, currency, transactionId }` (PSP confirmed, status `completed`)
  - `wallet.withdrawal.failed` - `{ userId, amount, currency, transactionId, adminId }` (PSP rejected; held funds returned, status `failed`)
  - All are recorded by the `audit` add-on (`SUBSCRIBED_TOPICS`); the `notifications` add-on subscribes to `approved`/`rejected` to notify the player.
- **Ports consumed**: `ADMIN_USER_DIRECTORY` (`lookupPlayers` for queue enrichment), `ADMIN_GUARD` (admin route authz).
- **Routes**: `src/router/index.ts`
- **UI slots**: none yet

## Ports

`PaymentAdapter` (symbol `PAYMENT_ADAPTER`) - the swap seam for a real PSP. `WalletService` injects it and calls it on every money movement: `deposit()` calls `processDeposit(amount, currency, metadata)` BEFORE crediting the balance, and `withdraw()` calls `processWithdrawal(...)` after the balance check and before debiting. The returned `externalId` is stored in the transaction's `metadata` column (JSON, alongside `provider`). The default binding is `MockPaymentAdapter` (returns `{ externalId, status: 'completed' }`).

To use a real PSP, implement `PaymentAdapter` under `adapters/<vendor>/` and bind it in an overlay plugin that loads AFTER the wallet module in `extensions.config.ts` - last registration to the `PAYMENT_ADAPTER` token wins, so the overlay's binding overrides `MockPaymentAdapter` with no fork:

```ts
ctx.provide(PAYMENT_ADAPTER, () => new StripePaymentAdapter());
```

## Do

- Add business logic to `service/wallet.service.ts` (inject `DrizzleService` from `@blurifycom/db`; query via `this.drizzle.db.select().from(wallet).where(eq(...))`)
- Add or edit `pgTable` defs in `src/schema/index.ts`, then run `pnpm regen`
- Implement `PaymentAdapter` in `adapters/<vendor>/` for real payment processing
- Emit cross-module events via `EventBus` - never import other modules directly

## Don't

- Import from other modules directly
- Throw framework HTTP errors from services - throw domain errors instead
- Edit the generated migrations under `packages/core/drizzle/` by hand - the source of truth is `src/schema/index.ts`
- Use floating-point for money calculations - money columns are `decimal(...)` (strings); read with `Number(record.balance)`, write as a string
- Add inline Zod schemas in the router - all schemas live in `schemas/` or the contract

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=wallet` shows the new/changed route(s) (e.g. `wallet.deposit`).
- No `boundaries/dependencies` lint errors (no cross-add-on code imports; read other add-ons' tables only via the `@blurifycom-addons/<name>/schema` subpath).
- If you changed the `PaymentAdapter` contract, `pnpm regen` then check `docs/catalog.json` shows the `PAYMENT_ADAPTER` seam still wired.
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.

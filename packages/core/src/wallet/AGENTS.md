# Wallet Module - AGENTS.md

## What this module does

Manages user balances, deposits, and withdrawals. Ships with `MockPaymentAdapter` as the default `PAYMENT_ADAPTER` binding - a synthetic PSP that returns `{ externalId, status: 'completed' }`. Emits domain events on completed transactions. Every user gets one wallet per system; money columns are Drizzle `decimal(...)` (strings in TS) to avoid floating-point drift - read with `Number(record.balance)`, write as a string (e.g. `'0'`).

## Routes

| Method | Path                 | Description                     |
| ------ | -------------------- | ------------------------------- |
| GET    | /wallet/balance      | Returns balance + currency      |
| POST   | /wallet/deposit      | Credit funds, emit domain event |
| POST   | /wallet/withdraw     | Debit funds if balance allows   |
| GET    | /wallet/transactions | Last 100 transactions for user  |

All routes require an authenticated caller (verified better-auth session via `getUserId`, ADR-0019).

## Extension points

- **Ports**: `PaymentAdapter` lives in `@blurifycom/adapters` and is passed into `WalletService` (the constructor takes a `PaymentAdapter`; `plugin.ts` resolves `PAYMENT_ADAPTER` from the container). The default binding is `MockPaymentAdapter` (bound in `src/plugin.ts`). Implement it for a real PSP and override the binding via an overlay plugin.
- **Events emitted**:
  - `wallet.deposit.completed` - `{ userId, amount, currency, transactionId }`
  - `wallet.withdrawal.completed` - `{ userId, amount, currency, transactionId }`
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

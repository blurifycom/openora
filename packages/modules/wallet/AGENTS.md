# Wallet Module - AGENTS.md

## What this module does

Manages user balances, deposits, and withdrawals. Ships with a stub implementation - no real PSP wired by default. Emits domain events on completed transactions. Every user gets one wallet per system; balances are `Decimal` to avoid floating-point drift.

## Routes

| Method | Path                 | Description                     |
| ------ | -------------------- | ------------------------------- |
| GET    | /wallet/balance      | Returns balance + currency      |
| POST   | /wallet/deposit      | Credit funds, emit domain event |
| POST   | /wallet/withdraw     | Debit funds if balance allows   |
| GET    | /wallet/transactions | Last 100 transactions for user  |

All routes require `x-user-id` header.

## Extension points

- **Ports**: `src/service/ports.ts` - implement `PaymentProvider` for a real PSP and bind it via `PAYMENT_PROVIDER` symbol in an overlay plugin.
- **Events emitted**:
  - `wallet.deposit.completed` - `{ userId, amount, currency, transactionId }`
  - `wallet.withdrawal.completed` - `{ userId, amount, currency, transactionId }`
- **Routes**: `src/router/index.ts`
- **UI slots**: none yet

## Ports

`PaymentProvider` (symbol `PAYMENT_PROVIDER`) - plug in a real PSP adapter by implementing this interface. The service does not call it directly yet; wire it via an overlay plugin.

## Do

- Add business logic to `service/wallet.service.ts`
- Add tables to `prisma.partial.prisma`, then run `pnpm regen`
- Implement `PaymentProvider` in `adapters/<vendor>/` for real payment processing
- Emit cross-module events via `EventBus` - never import other modules directly

## Don't

- Import from other modules directly
- Throw `HttpException` from services - throw domain errors instead
- Edit `infra/prisma/schema.prisma` directly
- Use floating-point for money calculations - keep using `Decimal` from Prisma
- Add inline Zod schemas in the router - all schemas live in `schemas/` or the contract

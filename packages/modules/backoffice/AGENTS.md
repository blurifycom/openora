# Backoffice Module - AGENTS.md

## What this module does

Admin API for managing users, viewing transactions, and querying platform stats.
This module provides the HTTP endpoints consumed by the `apps/backoffice` Next.js admin UI.
It does not own any DB tables - it reads from tables owned by `identity` (user) and `wallet` (wallet_transaction).

## Extension points

- Routes: `src/router/index.ts` - add new admin endpoints here
- Service: `src/service/backoffice.service.ts` - add new query/mutation methods
- Ports: `src/service/ports.ts` - add adapter interfaces for external analytics/reporting systems
- Events: emit `backoffice.*` events via the injected `EventBus` for audit logging

## Ports

None currently. If a reporting or analytics vendor is added, define an interface in `src/service/ports.ts` and implement under `adapters/<vendor>/`.

## Do

- Query across shared DB models (user, wallet_transaction) via the `PrismaWithAllModels` cast pattern
- Throw domain errors (`UserNotFoundError`) from the service, map to `ORPCError` in the router
- Return all dates as ISO strings
- Import contracts from `@oss/orpc-contract/backoffice` (subpath export)

## Don't

- Import from other modules directly (use shared DB or events)
- Throw `HttpException` or NestJS HTTP errors from service methods
- Add tenanted tables to `prisma.partial.prisma` without a `tenantId String` column
- Edit `infra/prisma/schema.prisma` directly

## Sample: add a new admin route

1. Add the contract entry to `packages/contracts/orpc-contract/src/backoffice.ts`
2. Add the service method to `src/service/backoffice.service.ts`
3. Add the handler to `src/router/index.ts` using `implement(contract.backoffice.<name>).handler(...)`
4. Run `pnpm regen && pnpm verify --filter @oss/module-backoffice`

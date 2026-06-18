# Backoffice Module - AGENTS.md

## What this module does

Admin API for managing users, viewing transactions, and querying platform stats.
This module provides the HTTP endpoints consumed by the `apps/backoffice` Vite + TanStack Router admin SPA.
It does not own any DB tables - it reads from tables owned by `identity` (user) and `wallet` (wallet_transaction).

## Extension points

- Routes: `src/router/index.ts` - add new admin endpoints here
- Service: `src/service/backoffice.service.ts` - add new query/mutation methods
- Ports: add adapter interfaces for external analytics/reporting systems to `@oss/adapters`
- Events: emit `backoffice.*` events via the injected `EventBus` for audit logging

## Ports

None currently. If a reporting or analytics vendor is added, define an interface in `@oss/adapters` and implement under `adapters/<vendor>/`.

## Do

- Read another add-on's tables by importing them via the subpath (`import { user } from '@oss-addons/identity/schema'`, `import { wallet, walletTransaction } from '@oss-addons/wallet/schema'`) and querying with `DrizzleService` - no casts needed
- Throw domain errors (`UserNotFoundError`) from the service, map to `ORPCError` in the router
- Return all dates as ISO strings
- Import contracts from `@oss/orpc-contract/backoffice` (subpath export)

## Don't

- Import from another add-on's service/runtime code directly (read its tables via the schema subpath, or use events)
- Throw `ORPCError` (or a domain error mapped via `mapErrors`) - never framework HTTP errors
- Edit the generated migrations under `packages/core/drizzle/` by hand - the source of truth is `src/schema/index.ts`

## Sample: add a new admin route

1. Add the contract entry to `packages/contracts/orpc-contract/src/backoffice.ts`
2. Add the service method to `src/service/backoffice.service.ts`
3. Add the handler to `src/router/index.ts` using `implement(contract.backoffice.<name>).handler(...)`
4. Run `pnpm regen && pnpm verify`

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=admin-console` shows the new/changed route(s) (e.g. `backoffice.listUsers`).
- Every admin route guards first: `await this.adminGuard.assert(context)` as the handler's first line.
- No `boundaries/dependencies` lint errors (no cross-add-on code imports; read other add-ons' tables only via the `@oss-addons/<name>/schema` subpath).

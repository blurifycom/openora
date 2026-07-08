# Admin-console Module - AGENTS.md

## What this module does

HTTP API for backoffice admin operations: user management, transaction viewing, and platform stats.
It does not own any DB tables - it reads from tables owned by `identity` (user) and `wallet` (wallet_transaction).
The backoffice SPA lives in the downstream consumer repo, not here (headless platform).

## Ports consumed

- `ADMIN_USER_DIRECTORY` - look up players by email/username for enrichment + KYC status
- `ADMIN_WALLET_REPORTING` - transaction ledger reads for admin queue views
- `ADMIN_GUARD` - authorize each admin route
- `AUDIT_WRITER` - record admin actions

## oRPC routes

| Procedure                 | Method | Path                         | Guard        |
| ------------------------- | ------ | ---------------------------- | ------------ |
| `backoffice.listUsers`    | GET    | `/backoffice/users`          | `admin:view` |
| `backoffice.getPlatform`  | GET    | `/backoffice/platform-stats` | `admin:view` |
| `backoffice.getUserStats` | GET    | `/backoffice/users/{userId}` | `admin:view` |

## Do

- Read sibling tables via their `/schema` subpath (`import { user } from '@openora/core/pam/schema/identity'`); query with `DrizzleService` from `@openora/core/server`
- Throw domain errors from the service; map to oRPC errors in the router
- Return all dates as ISO strings
- Guard every admin route first: `await adminGuard.assert(context, resource, action)` as the handler's first line
- Record admin actions via the `AUDIT_WRITER` port (no `backoffice.*` topics exist in `domainEventSchemas` - never invent topics)

## Don't

- Import another module's service/internals - read tables via schema subpath or use events
- Throw framework HTTP errors from the service - throw domain errors only
- Add new DB tables here (admin-console is read-only)

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=admin-console` shows the new/changed route(s).
- Every admin route is guarded (`AdminGuard.assert` first line).
- No `boundaries/dependencies` lint errors (read other domains' tables only via `@openora/core/<domain>/schema` subpath).

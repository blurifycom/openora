# admin-console

HTTP API for backoffice admin operations: user management, transaction viewing, platform stats. Owns NO tables - read-only over data owned by identity and wallet, reached via ports (`ADMIN_USER_DIRECTORY`, `ADMIN_WALLET_REPORTING`) and `/schema` subpath reads (`import { user } from '@openora/core/pam/schema/identity'`). The backoffice SPA lives in the downstream consumer (headless platform). Routes: `contract/index.ts` (or `list-routes module=admin-console`).

- Guard every route: `await adminGuard.assert(context, resource, action)` as the handler's first line.
- Record admin actions via `AUDIT_WRITER` - no `backoffice.*` topics exist in `domainEventSchemas`, never invent one.
- Don't add DB tables here (read-only module); don't import another module's service/internals.

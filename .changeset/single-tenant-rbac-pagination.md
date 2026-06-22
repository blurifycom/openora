---
'@blurifycom/core': minor
---

Single-tenant platform (ADR-0026): the `tenantId` column, RLS, the two-role
connection split, and server-side tenant resolution are removed. Backoffice RBAC

- a `(role x module) -> level` permission matrix with super-admin semantics. A shared offset-pagination kit (`@blurifycom/core/contracts/kit`:
  `PageQuerySchema` + `paginated`) with list endpoints returning
  `{ items, total, page, limit }`.

BREAKING CHANGE: `createApp` no longer accepts `resolveTenant`; `getTenantId` is
removed. The DB has no incremental path from the multi-tenant schema - recreate
from the new single-tenant baselines.

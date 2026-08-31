---
root: false
targets:
  - '*'
globs:
  - 'apps/api/**'
description: SQL / Drizzle conventions for tables an overlay or local add-on owns - the always-on core; full detail in docs/standards/database.md.
---

# Database conventions (SQL / Drizzle)

Applies to every table an overlay or local add-on owns (`apps/api/src/extensions/<name>/src/schema/`). Platform-domain tables live in `@openora/*` core - never edit those. Identifiers, timestamps, keys, indexes, N+1, idempotency and migrations are specified in `docs/standards/database.md` - read it before touching a schema, query, migration, or seed. The rules below are the ones that file does not state.

- Money: exact decimal, never float, never a scaled integer. Every money column is `decimal()` (Postgres `NUMERIC`) - never `real`/`float`, never an `integer` "cents" column. Pair it with a `currency` column; on the wire use `MoneyAmountSchema` (decimal string) + `currency`, never `z.number()`. Balance math runs in SQL, never JS float arithmetic.
- `pgEnum` derives from a values + schema + type triple declared once (never an inline value array): `X_STATUSES = [...] as const` -> `XStatusSchema = z.enum(X_STATUSES)` -> `pgEnum('x_status', X_STATUSES)`.
- Bound the fan-out: never `Promise.all(rows.map(fn))` when `rows` is a query result and `fn` calls out per row (a vendor adapter, another service) - it opens unbounded concurrent connections/requests and starves everything else at scale. Use `mapConcurrent(items, limit, fn)` (`@openora/core/server`).
- Audit every mutation: each state-changing action emits a domain event the `audit` add-on subscribes to, or resolves `AUDIT_WRITER` and calls `record(...)`. A mutation with no audit trail is not done.

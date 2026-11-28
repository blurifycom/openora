# Database conventions (SQL / Drizzle)

Read this in full before editing a schema, Drizzle query, migration config, or seed under
`apps/api/**`. Tables live in `@openora/*` core for platform domains - never edit those; these
rules govern the tables your overlay adds
(`apps/api/src/extensions/<name>/src/schema/`). Import/boundary rules live in `oss-boundaries`;
this file is SQL only.

## Identifiers - snake_case everywhere

Every drizzle instance sets `casing: 'snake_case'`, so the SQL name derives from the camelCase
key. Pass an explicit name only where casing can't derive it: table names, `pgEnum` types, index
names.

Name the table and the index explicitly in snake_case, keep the table constant camelCase, and let
the camelCase key derive the column name. Never pass an explicit or camelCase column name, and never
a PascalCase table name.

## Timestamps - always timestamptz

Declare every datetime column with the time zone so Postgres stores `timestamptz` in UTC; a naive
timestamp drops the zone. This covers every datetime column (`createdAt`, `updatedAt`, `expiresAt`,
any `*At`).

## Keys, references, indexes

- UUID primary keys (`uuid().primaryKey().defaultRandom()`).
- **No foreign keys across a module/overlay boundary** - store a plain ID string and resolve via
  the oRPC client or a schema subpath. FKs only within the same add-on.
- `NOT NULL` by default; push defaults to the DB (`.notNull().default(...)`), not app code.
- Index every column you filter or join on; name it `<table>_<cols>_idx`.

## Efficient operations

- Fetch related rows in one batched query with `inArray`, never one query per id in a loop (N+1).
- Select only the columns you use; don't `select(*)` wide rows to read one field.
- **Build rows by spread + override, never hand-copy field-by-field.** When a row mostly mirrors a
  validated input, spread it and set only the server-computed fields (`id`, `createdAt`) - never
  re-list each field by hand (it silently drifts the moment a column is added). Keep fields explicit only for: an order-sensitive hash/signature
  payload; a source carrying columns the row must not receive (spread then omit them); or a
  null-vs-undefined boundary that won't coerce (`actorId: input.actorId ?? null`).
- **Money / critical paths are transactional and idempotent** - a DB guard inside the transaction,
  not just an `idempotencyKey` (delivery is at-least-once). Put a unique index on the namespaced key
  and insert with `onConflictDoNothing`; an empty result means another request won, so re-read its
  row and return it as a replay. A check before the insert races: two deliveries of the same key
  both pass it.

## Migrations

- Never hand-edit generated migrations. Change the `pgTable`, then `pnpm db:migrate`.
- One migration per schema change; review the generated SQL before committing.

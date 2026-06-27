---
root: false
targets:
  - '*'
globs:
  - 'apps/api/**'
description: SQL / Drizzle conventions for tables an overlay or local add-on owns.
---

# Database conventions (SQL / Drizzle)

Applies to every table an overlay or local add-on owns (`apps/api/src/extensions/<name>/src/schema/`).
Tables live in `@blurifycom/*` core for platform domains - never edit those; these rules govern the
tables you add. Boundary/import rules live in `oss-boundaries`; this file is SQL only.

## Identifiers - snake_case everywhere

Every drizzle instance sets `casing: 'snake_case'`, so the SQL name derives from the camelCase key.
Pass an explicit name only where casing can't derive it: table names, `pgEnum` types, index names.

```ts
// good - key derives the column; const camelCase; explicit snake_case only for table + index
export const playerNote = pgTable(
  'player_note',
  {
    id: uuid().primaryKey().defaultRandom(),
    playerId: uuid().notNull(), // -> player_id
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('player_note_player_id_idx').on(t.playerId)],
);

// bad - explicit/camelCase column names, PascalCase table
pgTable('PlayerNote', { player_id: uuid('playerId') });
```

## Timestamps - always timestamptz

```ts
createdAt: timestamp({ withTimezone: true }); // good - Postgres timestamptz, store UTC
createdAt: timestamp(); // bad - naive, drops the zone
```

Every datetime column (`createdAt`, `updatedAt`, `expiresAt`, any `*At`) carries the zone.

## Keys, references, indexes

- UUID primary keys (`uuid().primaryKey().defaultRandom()`).
- **No foreign keys across a module/overlay boundary** - store a plain ID string and resolve via the
  oRPC client or a schema subpath. FKs only within the same add-on.
- `NOT NULL` by default; push defaults to the DB (`.notNull().default(...)`), not app code.
- Index every column you filter or join on; name it `<table>_<cols>_idx`.

## Efficient operations

```ts
// bad - N+1
for (const id of ids) await db.select().from(wallet).where(eq(wallet.playerId, id));
// good - one batched query
await db.select().from(wallet).where(inArray(wallet.playerId, ids));
```

- Select only the columns you use; don't `select(*)` wide rows to read one field.
- **Money / critical paths are transactional and idempotent** - a DB guard inside the transaction,
  not just an `idempotencyKey` (delivery is at-least-once).

```ts
await db.transaction(async (t) => {
  if (await ledgerExists(t, idempotencyKey)) return; // guard, not just a key
  await insertLedger(t, { idempotencyKey, amountCents });
});
```

## Migrations

- Never hand-edit generated migrations. Change the `pgTable`, then `pnpm db:migrate`.
- One migration per schema change; review the generated SQL before committing.

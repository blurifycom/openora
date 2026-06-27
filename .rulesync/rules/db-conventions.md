---
root: false
targets:
  - '*'
globs:
  - 'packages/addons/**'
  - 'packages/core/**'
description: SQL / Drizzle conventions - snake_case identifiers, timestamptz, keys, indexing, efficient ops, migrations.
---

# Database conventions (SQL / Drizzle)

The authoritative SQL rule for the platform. Tables live in an add-on's `src/schema/index.ts` (core
add-ons join central `packages/core/drizzle/`; gated add-ons own their `drizzle.config.ts`). Layering
and DI live in `clean-architecture`; import boundaries in `overview` > Dependency rules. This is SQL only.

## Identifiers - snake_case everywhere

Every drizzle instance + drizzle-kit config sets `casing: 'snake_case'`, so the SQL name derives from
the camelCase key. Pass an explicit name only where casing can't derive it: table names, `pgEnum`
types, and index/constraint names.

```ts
// good - key derives the column; const camelCase; explicit snake_case only where needed
export const walletTransaction = pgTable(
  'wallet_transaction',
  {
    id: uuid().primaryKey().defaultRandom(),
    walletId: uuid().notNull(), // -> wallet_id
    type: walletTransactionType().notNull(), // pgEnum('wallet_transaction_type', ...)
    amountCents: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wallet_transaction_wallet_id_idx').on(t.walletId)],
);

// bad - explicit/camelCase column names, PascalCase table
pgTable('WalletTransaction', { wallet_id: uuid('walletId') });
```

Row type is `typeof walletTransaction.$inferSelect`; never hand-write it.

## Timestamps - always timestamptz

```ts
createdAt: timestamp({ withTimezone: true }); // good - Postgres timestamptz, store UTC
createdAt: timestamp(); // bad - naive, drops the zone
```

Applies to every datetime column (`createdAt`, `updatedAt`, `expiresAt`, any `*At`).

## Keys, references, indexes

- UUID primary keys (`uuid().primaryKey().defaultRandom()`).
- **No foreign keys across an add-on/module boundary** - store a plain ID string and resolve via a
  command port, event, or read-only `/schema` subpath. FKs only within the same add-on.
- `NOT NULL` by default; push defaults to the DB (`.notNull().default(...)`).
- Index every column you filter or join on; name it `<table>_<cols>_idx`. Run `propose-table-change`
  (MCP) before adding a table to catch collisions.

## Efficient operations

```ts
// bad - N+1
for (const id of ids) await db.select().from(wallet).where(eq(wallet.id, id));
// good - one batched query
await db.select().from(wallet).where(inArray(wallet.id, ids));
```

- Select only the columns you use; don't read wide rows for one field.
- **Money / critical paths are transactional and idempotent** - a DB guard inside the transaction,
  not just an `idempotencyKey` (delivery is at-least-once).

```ts
await db.transaction(async (t) => {
  if (await ledgerExists(t, idempotencyKey)) return; // guard, not just a key
  await insertLedger(t, { idempotencyKey, amountCents });
});
```

## Migrations

- Never hand-edit generated migrations (or `docs/openapi.json` / `docs/catalog.json`). Change the
  `pgTable`, then `pnpm regen` (drizzle-kit generates the migration + emits OpenAPI + catalog).
- Core add-ons use central `packages/core/drizzle/`; gated add-ons own their `migrations/`.

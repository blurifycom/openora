# Database conventions (SQL / Drizzle)

Read this in full before editing a schema, Drizzle query, migration configuration, seed, or database tool. Tables live in a module's `src/schema/index.ts`; every module owns its own `drizzle.config.ts` and co-located `drizzle/migrations/` history (ADR-0027). Layering and DI live in `docs/standards/module-structure.md`; import boundaries in `overview` > Dependency rules.

## Enums - pgEnum derives from the contract tuple

Never an inline value array (lint error `oss-module-shape/no-inline-pg-enum`). Declare the set once on the contract surface as a tuple + `z.enum` + inferred type (see `docs/standards/types.md`), then `pgEnum('x_status', X_STATUSES)` - the DB enum can never drift from the contract, and consumers import the same values. Reference: `wallet/schema/index.ts`.

## Identifiers - snake_case everywhere

Every Drizzle instance and drizzle-kit config sets `casing: 'snake_case'`, so the SQL name derives from the camelCase key. Pass an explicit name only where casing cannot derive it: table names, `pgEnum` types, and index/constraint names.

The first declaration is valid; the second violates the naming rule.

```ts
export const walletTransaction = pgTable(
  'wallet_transaction',
  {
    id: uuid().primaryKey().defaultRandom(),
    walletId: uuid().notNull(),
    type: walletTransactionType().notNull(),
    amount: decimal({ precision: 18, scale: 2 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wallet_transaction_wallet_id_idx').on(t.walletId)],
);

pgTable('WalletTransaction', { wallet_id: uuid('walletId') });
```

Lint error `oss-module-shape/drizzle-snake-case` rejects a non-snake table, enum, or index name and an explicit camelCase column name. Row type is `typeof walletTransaction.$inferSelect`; never hand-write it.

## Money - exact decimal, never float, never scaled integer

Every money column is `decimal()` (Postgres `NUMERIC`) - never `real`/`float`, never an `integer` "cents" column. Pair it with a `currency` column; on the wire, use the shared `MoneyAmountSchema` (decimal string) + `currency`, never `z.number()`. Balance math runs in SQL (`sql\`${wallet.balance} + ${amount}::numeric\``), never JS float arithmetic. Multi-currency exponents, crypto, and existing wire-format conventions require this. Full rationale: ADR-0029.

Lint error `oss-module-shape/no-float-money` bans a float-typed column in a schema file.

## Timestamps - always timestamptz

The first declaration is valid; the second uses a naive timestamp and is invalid.

```ts
createdAt: timestamp({ withTimezone: true });
createdAt: timestamp();
```

Applies to every datetime column (`createdAt`, `updatedAt`, `expiresAt`, any `*At`). Lint error `oss-module-shape/no-naive-timestamp` flags a `timestamp()` missing `{ withTimezone: true }`.

## Keys, references, indexes

- UUID primary keys (`uuid().primaryKey().defaultRandom()`).
- No foreign keys across a module boundary - store a plain ID string and resolve via a command port, event, or read-only `/schema` subpath. FKs only within the same module.
- `NOT NULL` by default; push defaults to the DB (`.notNull().default(...)`).
- Index every column you filter or join on; name it `<table>_<cols>_idx`. Run `propose-table-change` before adding a table to catch collisions.

## Efficient operations

The first query is an N+1 anti-pattern; the second is the required batched query.

```ts
for (const id of ids) await db.select().from(wallet).where(eq(wallet.id, id));
await db.select().from(wallet).where(inArray(wallet.id, ids));
```

- Select only the columns you use; do not read wide rows for one field.
- Bound the fan-out - never `Promise.all(rows.map(fn))` when `rows` is a query result and `fn` touches the DB. Use `mapConcurrent(items, limit, fn)` (`@openora/core/server`). Lint: `oss-module-shape/no-unbounded-db-fanout`.
- Critical mutations are transactional and idempotent - a DB guard inside the transaction, not just an `idempotencyKey`.

```ts
await db.transaction(async (t) => {
  if (await ledgerExists(t, idempotencyKey)) return;
  await insertLedger(t, { idempotencyKey, amount });
});
```

## Migrations

- Never hand-edit generated migrations or `docs/catalog.json`. Change the `pgTable`, then run `pnpm regen`.
- Every module owns its own `drizzle/migrations/` + `__drizzle_migrations_<id>` tracking table, co-located with its schema. One shared database, one journal per module.
- A Postgres extension an index needs (for example `pg_trgm`) goes in the module `migrate()` `extensions` option, never hand-edited into a regenerated migration.

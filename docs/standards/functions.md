# Functions, classes, and side effects

Detail for the "functional and declarative" line in `conventions`. Read this when writing or refactoring a function, a service method, or a constructor.

- **Pure functions with dependencies passed in; side effects at the edges.** `price(cart, rate)` - the caller owns the IO, not `price(cart)` reading a rate inside.
- **Immutability - derive, don't mutate.** `{ ...user, roles: [...user.roles, 'admin'] }`, not `user.roles.push('admin')`.
- **Construct objects by spread + override, never hand-copy field-by-field.** When a new object mostly mirrors an existing one (a DB insert from a validated input, a patch, a re-shaped payload, a row -> DTO), spread the source and set only what differs - `db.insert(x).values({ ...input, id, createdAt, hash })` - never re-list `field: input.field` per key. The hand-written copy is pure noise that silently drifts the moment a field is added on one side. For a row -> DTO that only turns `Date`/`Decimal` into strings, use `serializeRow(row, { dateFields, decimalFields })`, not a manual map. Three cases keep fields explicit, and only these: (1) **order-sensitive serialization** - a hash/signature canonical form ties its bytes to key order, so list keys by hand and treat the list as append-only; (2) the source carries **fields the target must not receive** - spread then `.omit`/destructure them off, or list explicitly; (3) **null vs undefined matters at a boundary that won't coerce** - normalize once (`actorId: input.actorId ?? null`) rather than relying on a spread passing `undefined` through.

  ```ts
  // bad - re-lists every field; adding `userAgent` to the schema silently drops it here
  .values({ id, actorId: input.actorId ?? null, actorType: input.actorType, action: input.action })
  // good - spread the validated input, override only the server-computed fields
  .values({ ...input, createdAt: input.createdAt.toISOString() })
  ```

- **A `class` is only a thin dependency-holding shell at a composition root; methods delegate to pure functions.**
- **No inheritance for reuse - compose.** No decorators anywhere.
- **Short, single-purpose functions.** If you'd comment "// step 2" inside a function, extract it.
- **Guard clauses first, main path last.** Early-return the edge/simple cases up top; keep the biggest branch as the final unguarded return - flatter and easier to read than wrapping it in an `if`.

  ```ts
  // bad - main branch nested in an if
  if (Array.isArray(v)) {
    return v.map(f);
  }
  if (v !== null && typeof v === 'object') {
    return heavy(v);
  }
  return v;
  // good - edge cases guarded, heavy branch falls through to the end
  if (Array.isArray(v)) {
    return v.map(f);
  }
  if (v === null || typeof v !== 'object') {
    return v;
  }
  return heavy(v);
  ```

- **Always brace control statements** - every `if`/`else`/`for`/`while` body in `{ }`, even one-liners (lint: `curly`).

  ```ts
  // bad
  if (isActive) return true;
  // good
  if (isActive) {
    return true;
  }
  ```

- **Don't annotate a return type TypeScript can infer** - the body is the single source of truth. Annotate ONLY when:
  - inference can't (recursion), or
  - you deliberately widen/narrow, or
  - it's a **published SDK export with no re-checking seam** - `/react` hooks + the typed client + plain-value `/server` helpers - where the explicit type IS the public contract (an inferred return silently leaks a refactor as a downstream breaking change).

  Routers, service methods, contracts, schemas, and plugins stay inferred: a seam re-checks them (oRPC validates handler output against the contract) or the type is an unspellable oRPC/Drizzle structure. Argument types always explicit.

- **More than 3 parameters -> a single named-object param.** Four or more positionals are unreadable at the call site (`f(txn, ns, id, key, amt, cur, vals)` - which string is which?) and silently break when two share a type. Pass one object and destructure; a leading handle like a `tx`/`trx` may stay positional. Applies to functions, service methods, and constructors alike.

  ```ts
  // bad - 7 positionals, three interchangeable strings
  insertIdempotentTransaction(
    txn,
    namespace,
    walletId,
    rawIdempotencyKey,
    amount,
    currency,
    values,
  );
  // good - named object, self-documenting call site
  insertIdempotentTransaction(txn, {
    namespace,
    walletId,
    rawIdempotencyKey,
    amount,
    currency,
    values,
  });
  ```

- **Named exports only - no default exports.** Two sanctioned exceptions: `plugin.ts` (the loader reads `mod.default`, `load-plugins.ts:85`) and `drizzle.config.ts` (drizzle-kit requires it).

## State and side effects

- **Side effects at the edges** (services, adapters, plugins, handlers), never in pure helpers. Events emit from the service after the DB commit.
- **Server state is owned by the data layer** - no ad-hoc shadow caches.

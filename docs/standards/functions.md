# Functions, classes, and side effects

Detail for the "functional and declarative" line in `conventions`. Read this when writing or refactoring a function, a service method, or a constructor.

- **Pure functions with dependencies passed in; side effects at the edges.** A pricing function takes the cart and the rate as arguments - the caller owns the IO, the function never reads the rate inside.
- **Immutability - derive, don't mutate.** Build a new user with an extended roles list rather than pushing onto the existing array.
- **Construct objects by spread + override, never hand-copy field-by-field.** When a new object mostly mirrors an existing one (a DB insert from a validated input, a patch, a re-shaped payload, a row -> DTO), spread the source and set only what differs (an insert spreads the validated input and overrides the server-computed fields, as in `packages/core/src/pam/player-note/service/player-note.service.ts`) - never re-list each field of the source by hand; adding a field to the schema would then silently drop it. The hand-written copy is pure noise that silently drifts the moment a field is added on one side. For a row -> DTO that only turns `Date`/`Decimal` into strings, use `serializeRow(row, { dateFields, decimalFields })`, not a manual map. Three cases keep fields explicit, and only these: (1) **order-sensitive serialization** - a hash/signature canonical form ties its bytes to key order, so list keys by hand and treat the list as append-only; (2) the source carries **fields the target must not receive** - spread then `.omit`/destructure them off, or list explicitly; (3) **null vs undefined matters at a boundary that won't coerce** - normalize once (coalesce a missing actor id to null once) rather than relying on a spread passing `undefined` through.

- **A `class` is only a thin dependency-holding shell at a composition root; methods delegate to pure functions.**
- **No inheritance for reuse - compose.** No decorators anywhere.
- **Short, single-purpose functions.** If you'd comment "// step 2" inside a function, extract it.
- **Guard clauses first, main path last.** Early-return the edge/simple cases up top; keep the biggest branch as the final unguarded return - flatter and easier to read than wrapping it in an `if`. Test the edge case that returns the input unchanged first, and let the heavy branch fall through to the final return.

- **Always brace control statements** - every `if`/`else`/`for`/`while` body in `{ }`, even one-liners (lint: `curly`). A braceless early return is a violation.

- **Don't annotate a return type TypeScript can infer** - the body is the single source of truth. Annotate ONLY when:
  - inference can't (recursion), or
  - you deliberately widen/narrow, or
  - it's a **published SDK export with no re-checking seam** - `/react` hooks + the typed client + plain-value `/server` helpers - where the explicit type IS the public contract (an inferred return silently leaks a refactor as a downstream breaking change).

  Routers, service methods, contracts, schemas, and plugins stay inferred: a seam re-checks them (oRPC validates handler output against the contract) or the type is an unspellable oRPC/Drizzle structure. Argument types always explicit.

- **More than 3 parameters -> a single named-object param.** Four or more positionals are unreadable at the call site (with seven positionals, which of three strings is which?) and silently break when two share a type. Pass one object and destructure; a leading handle like a `tx`/`trx` may stay positional. Applies to functions, service methods, and constructors alike. `insertIdempotentTransaction` in `packages/core/src/wallet/service/wallet.service.ts` takes the handle plus one named object.

- **Named exports only - no default exports.** Two sanctioned exceptions: `plugin.ts` (the loader reads `mod.default`, `load-plugins.ts:85`) and `drizzle.config.ts` (drizzle-kit requires it).

## State and side effects

- **Side effects at the edges** (services, adapters, plugins, handlers), never in pure helpers. Informational events emit after commit via `emit`; money, compliance and RG events are written in the transaction via `emitInTransaction`.
- **Server state is owned by the data layer** - no ad-hoc shadow caches.

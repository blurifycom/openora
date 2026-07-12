---
description: >-
  Engineering code conventions (TS, headless backend) - apply to every code
  change.
applyTo: '**/*.ts,**/*.tsx,**/*.mjs'
---

# Engineering Conventions

The portable code standard - stack-agnostic principles, then TS/backend specifics. Structure/DI/boundaries: `clean-architecture`. Async seams: `messaging-and-microservices`. OSS naming, forbidden patterns, decision tree: `overview`. Keep this file portable (shared with the consumer repo).

Goal: code that is clean, separated, scalable, and extendible - easy to understand and cheap to change. Examples show `// bad` (the smell) vs `// good` (the convention).

## 1. Philosophy

- **Functional and declarative by default.** Pure functions, immutable data, composition over imperative mutation and stateful classes. `orders.map((o) => o.amount * o.qty)`, not a `for` loop pushing into an accumulator.
- **Explicit over magic.** No auto-discovery, no decorator/reflection soup. Every wiring point is a greppable, typed call: `ctx.provide(SEND_EMAIL, () => new SmtpMailer(env.SMTP_URL))`, never `@Injectable()`.
- **Self-documenting.** Clear names beat comments: `percentChange`, not `d` + a comment.
- **Small and composable.** One concept per file; `parseUser()` + `sendWelcomeEmail()`, not `parseUserAndSendEmail()`.
- **YAGNI + DRY, in that order.** Don't build for imagined futures; abstract on the third occurrence, not the first. `settleBet(bet)`, not a one-caller `process(config, strategy, adapters, plugins)` engine.
- **Boring and consistent.** Match the surrounding code's idiom, naming, and density.

## 2. Naming

- Files `kebab-case.ts`, one concept per file, filename names the concept: `wallet.service.ts`, `format-money.ts` - never `helpers.ts`, `utils2.ts`.
- Types `PascalCase`; values/functions `camelCase`; true global constants `SCREAMING_SNAKE_CASE`.
- Schemas `<Name>Schema`; the inferred type is the bare `<Name>`.
- Booleans read as predicates (`isActive`, `canEdit`, `hasLoaded`); IO functions as verbs (`fetchInvoice`).
- Names carry units/intent: `delayMs`, `maxRetries` - never bare `delay`, `max`. Money is the one exception to "unit in the name": it's a decimal string + a `currency` field alongside (`amount`/`balance`/`threshold`, never `amountCents` - see `db-conventions` > Money, ADR-0029).

## 3. Types and data modeling

- **One source of truth per shape - infer, never hand-write.** `z.infer<typeof UserSchema>`, `typeof users.$inferSelect`, `Omit<User, 'id'>`.
- **Schema-first at every boundary** (HTTP, config, env, messages, events). Validate once at the edge, trust the type after. oRPC + Zod does this for routes; do the same for config/env/event payloads.
- **No `any`, anywhere - tests included.** `unknown` + narrowing, or the real type. Never hand-roll a duplicate of a type that's one import away (`$inferSelect`/`$inferInsert`, a shared `@openora/core/*` type) - it silently drifts from the source of truth.
- **Never re-infer an imported schema** - the type is exported once from the owning contract; consumers import it, never re-run `z.infer` (lint: `oss-module-shape/no-reinfer-imported-schema`).
  ```ts
  export type PlayerProfile = z.infer<typeof PlayerSchema>; // bad
  import type { Player } from '@openora/core/contracts'; // good
  ```
- **No type casts (`as`) to silence the compiler - fix the root cause.** (`as const` is fine.) `as unknown as X` turns type-checking off entirely. If a symbol needs a type, give it one at the source (`createToken<T>()`), don't cast at use sites. Exactly two sanctioned exceptions:
  1. **Test doubles** - route through the `mock` / `mockDb` / `readPrivate` helpers (`packages/core/src/testing/mock.ts`) so the cast lives in one audited place, never inline in a test.
  2. **Third-party type-inference boundaries** a library gives you no honest way to satisfy - one cast with a one-line `// Library boundary:` note.

  ```ts
  // bad
  const user = data as User;
  const svc = { db } as unknown as DrizzleService;
  // good
  const user = UserSchema.parse(data);
  const TOKEN = createToken<Config>('CONFIG');
  const svc = mockDb(db); // test double, cast confined to the helper
  ```

- **Never `!` non-null assertions** - narrow or restructure instead (lint: `typescript/no-non-null-assertion`).
  ```ts
  return toDto(row!); // bad
  return toDto(findOneOrThrow(rows, new XNotFoundError(id))); // good
  ```
- **Under `noUncheckedIndexedAccess`: `.at()`, destructuring-with-defaults, or an explicit guard - never `arr[i]!`.** `const [first = ''] = parts;`
- **`type` over `interface`** (lint-enforced).
- **Type entity ids through their owning type**: `User['id']`, never a bare `string` - the id's representation lives in one place and every signature follows when it changes (lint: `oss-module-shape/no-bare-string-id-param`). Bad: `roleId: string`. Good: `roleId: AdminRole['id']`.
- **Derive related schemas, never re-type fields**: `UserSchema.partial().omit({ id: true })`.
- **Enum-like value sets are a values + schema + type triple, declared once on the contract surface**: `X_STATUSES = [...] as const` -> `XStatusSchema = z.enum(X_STATUSES)` -> inferred `XStatus`. Anything in a route contract is public API - consumers need the runtime values (dropdowns, badge maps), so types alone are not enough. Never TS `enum`; never a second hand-typed copy of the set (in a consumer either - import it). Inline `z.enum([...])` outside a contract dir is a lint error (`oss-module-shape/no-inline-z-enum-outside-contract`).
- **Reuse `UuidSchema`** (`@openora/core/contracts`) for uuid fields, never a raw `z.uuid()`/`z.string().uuid()` - one source of truth for the shape (lint: `oss-module-shape/no-raw-z-uuid`).
- **Make illegal states unrepresentable** - discriminated unions (`{ status: 'loading' } | { status: 'ok'; data } | { status: 'error'; error }`) over optional-flag soup (`{ loading: boolean; data?: T; error?: Error }`).

## 4. Functions, modules, and classes

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

## 5. Comments and documentation

- **Default to zero comments.** Add one only when the code can't say it: architectural context (why this order, why not the obvious approach) or an implicit constraint/invariant/workaround. `// Stripe rounds half-to-even; mirror it so our totals reconcile.` - never `// increment the counter`.
- **If a block needs a comment to be understood, rename/extract first.**
- **No section-divider comments** (`// ---`, `// ===`).
- **JSDoc on every exported function/class >~15 lines or with non-obvious params.** Multiline `/** ... */` block (opening and closing on their own lines). Document the surprising contract, not the name.
- **`// TODO:` for deferred work, `// FIXME:` for known-broken code** - greppable, with context and an issue key where one exists. Never bare.
  ```ts
  // TODO: replace polling with the webhook once BE ships it (ABC-312)
  // FIXME: race - two admins approving the same withdrawal double-credit the player
  ```
- **`// mock:` marks placeholder data / stubbed behavior** so throwaway code stays findable. `// mock: fixed rate until the FX adapter lands`

## 6. Structure and boundaries

(The enforced import graph lives in `overview` > Dependency rules and `clean-architecture`.)

- **Never import another module's internals.** Cross-module needs go through a command port, a domain event, or a shared contract.
- **Dependency direction points inward:** router -> service -> contracts; engine never imports a domain.
- **Public API is the package/subpath entry**, never a deep `dist/`/`src/` path.
- **No deep (`../../`+) relative import that leaves your own zone/module** - a `..` crossing into another domain, slice, or engine zone is a bug; use the `@openora/core/*` subpath. Relative paths stay inside your own dir (`./x`, `../schema/index.js`). Lint: `oss-module-shape/no-relative-zone-escape`.
- **No import cycles** - extract a shared module or move the type to contracts.

## 7. React SDK (`@openora/core/react` + domain `react/` dirs)

Headless repo - only the SDK consumption layer (hooks, typed client, auth, realtime) lives here, no UI.

- **One `useX` per concern, returning a plain object** (`{ wallet, isLoading }`).
- **Hand-write `useMemo`/`useCallback` wherever a returned value/function is part of a hook's stability contract** - the OPPOSITE of the consumer-app rule, because the consumer's React Compiler does not reprocess pre-built `node_modules`. Keep hooks Rules-of-React compliant so the consumer's compiler can optimize callers.
- **Server state is not client state** - key/cache/invalidate via the query lib, never a raw `useEffect(fetch)`.

## 8. State and side effects

- **Side effects at the edges** (services, adapters, plugins, handlers), never in pure helpers. Events emit from the service after the DB commit.
- **Server state is owned by the data layer** - no ad-hoc shadow caches.

## 9. Error handling

- **Fail fast at boundaries with typed errors** - `Schema.parse(raw)` throws early.
- **No silent catches** - log with context and rethrow, or handle explicitly.
- **Typed, named error classes mapped to transport at the edge.** Use the shared factories (`makeNotFoundError`/`makeOwnershipError`/`makeConflictError`); the router's `mapErrors` keys off the exported class. `export const WalletNotFoundError = makeNotFoundError('Wallet');`
- **Money / critical paths are transactional and idempotent** - a DB guard inside the transaction, not just an `idempotencyKey` (delivery is at-least-once):
  ```ts
  await db.transaction(async (t) => {
    if (await ledgerExists(t, idempotencyKey)) return;
    await insertLedger(t, { idempotencyKey, amount });
  });
  ```

## 10. Testing

- **Co-locate as `__tests__/<name>.test.ts` (Vitest).** Service tests use a vi-mocked Drizzle.
- **Test behaviour, not implementation** - assertions survive a safe refactor: `expect(await service.get(id)).toEqual(user)`, not `expect(service._cache.size).toBe(1)`.
- **Cover new logic as part of the change** - unit for pure fns; always include authz negatives.
- **Deterministic and isolated:** no shared mutable state, no real network, seedable data.

## 11. Dependencies

- **Pin exact versions** (no `^`/`~`).
- **No inline `fetch`/`axios` in module code** - third-party integrations are ports + adapters bound at the root.
- **Add a dependency deliberately** - prefer stdlib/small packages; a few lines often beat a tree.

## 12. Git and delivery

- **Conventional commits, enforced** (commitlint on commit + CI). Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `perf`. The scope is a workspace-derived `scope-enum` (module dirs, apps, plus `ci`/`deps`/`rules`/`repo`/`tooling`); an unlisted scope fails - check with `pnpm commitlint --from HEAD~1` or omit the scope. `feat(wallet): atomic debit command port`
- **Subject must start lowercase** (`subject-case`), acronyms included - write `feat(pam): kyc status filter`, not `KYC`. This applies to the **PR title too**: squash-merge derives the `dev` commit message from the PR title, which local commit hooks never lint - an uppercase title lands a failing commit on `dev`.
- **One PR = one concern.** Stage files explicitly; never `git add -A` with foreign changes in the tree.
- **Green before review:** `pnpm verify` passes; `pnpm regen` after any contract/schema change.
- **Branch off `dev`; never commit directly to `dev`/`stage`.** Promotion chain `dev -> stage` + release tags. Never push without an explicit per-action confirmation.
- **PR description carries intent:** what / why / acceptance criteria / ticket key.
- **No sensitive/internal data in titles, descriptions, or commits** - they are the public record. Bare ticket key (`ABC-45`), never the URL; no internal links, hostnames, secrets, PII. When in doubt, leave it out.

## 13. Enforcement

- `pnpm verify` = typecheck + unit tests + oxlint + module-shape + `pnpm boundaries` (dependency-cruiser).
- Two-layer boundaries (per-edit oxlint + whole-graph cruiser) - don't work around a violation; fix the import.
- Module structure + naming are lint-enforced (`oss-module-shape/*` oxlint JS plugin): files sit in a canonical layer dir, `service/` files end `.service.ts`, `__tests__/` files end `.test.ts`, filenames kebab-case, no inline `pgEnum` value arrays.
- oxlint config is split: the published `@openora/core/oxlint/oxlintrc.json` holds the universal, stack-agnostic rules (base rules, `typescript/no-explicit-any`, `typescript/no-non-null-assertion`, `typescript/consistent-type-definitions`, `import/no-cycle`, `import/no-duplicates`) - the single source of truth a consumer extends via `"extends": ["./node_modules/@openora/core/oxlint/oxlintrc.json"]`. The root `.oxlintrc.json` here `extends` that shared config and adds only OSS-internal rules (`oss-boundaries/*`, `oss-module-shape/*`, `unicorn/filename-case`) that need the local `jsPlugins`.
- Pre-commit runs `pnpm boundaries`; CI runs `pnpm verify` + the no-drift check.
- Agent rules mirror this standard - generated from `.rulesync/` via `pnpm sync:agents`.

---
root: false
targets:
  - '*'
globs:
  - '**/*'
description: Engineering code conventions (TS, headless backend) - apply all of these to every change.
---

# Engineering Conventions

The portable code standard, scoped to this headless backend repo. Stack-agnostic
principles first, then the TypeScript and backend specifics that implement them.
Structure/DI/boundaries live in `clean-architecture`; async/seams in
`messaging-and-microservices`; OSS-specific naming, forbidden patterns, and the
decision tree in `overview`. This file is the code-style baseline shared with the
consumer repo - keep it portable; put OSS-only rules in those other files.

Each rule carries a short example. `// bad` shows the smell, `// good` the convention.

> The goal: code that is clean, separated, scalable, customizable, and extendible -
> and that stays easy to understand and cheap to change as the team and codebase grow.

---

## 1. Philosophy (first principles)

- **Functional and declarative by default.** Prefer pure functions, immutable data, and
  composition over imperative mutation and stateful classes.

  ```ts
  // bad - imperative accumulation
  const totals = [];
  for (const o of orders) totals.push(o.amount * o.qty);

  // good - declarative transform
  const totals = orders.map((o) => o.amount * o.qty);
  ```

- **Explicit over magic.** No auto-discovery, no decorator/reflection soup. Every wiring
  point is a greppable, typed call (here: the `Container` + tokens).

  ```ts
  // bad - decorator/DI magic resolved at runtime by string
  @Injectable()
  class Mailer {}

  // good - explicit factory wiring
  ctx.provide(SEND_EMAIL, () => new SmtpMailer(env.SMTP_URL));
  ```

- **Self-documenting.** Clear names beat comments.

  ```ts
  // bad
  const d = (a - b) / b; // percent change
  // good
  const percentChange = (current - previous) / previous;
  ```

- **Small and composable.** One concept per file; split when a unit does two things.

  ```ts
  // bad: parseUserAndSendEmail()  -> good: parseUser() + sendWelcomeEmail()
  ```

- **YAGNI + DRY, in that order.** Don't build for imagined futures; do remove real
  duplication. Abstract on the third occurrence, not the first.

  ```ts
  // bad - a "flexible" engine used in exactly one place
  process(config, strategy, adapters, plugins);
  // good - the concrete thing you actually need
  settleBet(bet);
  ```

- **Boring and consistent.** Match the surrounding code's idiom, naming, and density.

---

## 2. Naming

(OSS-specific naming - package scopes, oRPC namespaces, Drizzle table casing,
`tenantId` - lives in `overview` > Naming. The cross-cutting basics:)

- **Files `kebab-case.ts`, one concept per file; filename names the concept.**

  ```
  wallet.service.ts   format-money.ts   id-input.schema.ts     // good
  WalletService.ts    helpers.ts        utils2.ts              // bad
  ```

- **Types `PascalCase`; values/functions `camelCase`; true global constants `SCREAMING_SNAKE_CASE`.**

  ```ts
  type OrderLine = { ... };
  const orderLine = parseLine(raw);
  const MAX_RETRIES = 3;
  ```

- **Schemas `<Name>Schema`; inferred type is the bare `<Name>`.**

  ```ts
  const UserSchema = z.object({ id: z.string() });
  type User = z.infer<typeof UserSchema>;
  ```

- **Booleans read as predicates.**

  ```ts
  // bad: active, edit, loadDone
  // good: isActive, canEdit, hasLoaded
  ```

- **IO functions read as verbs.**

  ```ts
  async function fetchInvoice(id: string) { ... }
  ```

- **Names carry units/intent.**

  ```ts
  // bad: delay, max, price
  // good: delayMs, maxRetries, amountCents
  ```

---

## 3. Types and data modeling

- **One source of truth per shape. Never hand-write a type that already exists - infer it.**

  ```ts
  // bad - duplicated, drifts from the schema
  type User = { id: string; email: string };
  // good - derived
  type User = z.infer<typeof UserSchema>;
  type UserRow = typeof users.$inferSelect;
  type CreateUser = Omit<User, 'id'>;
  ```

- **Schema-first at every boundary (HTTP, config, env, messages, events).** Validate once
  at the edge, trust the type after. oRPC + Zod does this for routes; do the same for
  config/env/event payloads.

  ```ts
  const body = CreateOrderSchema.parse(input);
  ```

- **No `any` outside tests - use `unknown` + narrowing.**

  ```ts
  // bad
  function parse(input: any) {
    return input.value;
  }
  // good
  function parse(input: unknown) {
    return ResultSchema.parse(input).value;
  }
  ```

- **No type casts (`as`) to silence the compiler - fix the root cause.** (`as const` is fine.)

  ```ts
  // bad - hides a wrong/missing type
  const user = data as User;
  // good - validate, or fix the source type/import
  const user = UserSchema.parse(data);
  const ROLES = ['admin', 'player'] as const; // ok
  ```

- **`type` over `interface`** (lint-enforced).

  ```ts
  type Props = { title: string };
  ```

- **Derive related schemas, never re-type fields** - `.pick()`/`.omit()`/`.partial()`/`.extend()`/`.merge()`.

  ```ts
  const UpdateUserSchema = UserSchema.partial().omit({ id: true });
  ```

- **Make illegal states unrepresentable - discriminated unions over optional-flag soup.**

  ```ts
  // bad
  type State = { loading: boolean; data?: T; error?: Error };
  // good
  type State =
    | { status: 'loading' }
    | { status: 'ok'; data: T }
    | { status: 'error'; error: Error };
  ```

---

## 4. Functions, modules, and classes

(Service/router/plugin layering + DI specifics live in `clean-architecture`. The style:)

- **Pure functions with dependencies passed in; side effects at the edges.**

  ```ts
  // bad - reaches out to IO inside the logic
  function price(cart) {
    return cart.total * getRate();
  }
  // good - dependency is an argument; caller owns the IO
  function price(cart: Cart, rate: number) {
    return cart.total * rate;
  }
  ```

- **Immutability - derive, don't mutate.**

  ```ts
  // bad
  user.roles.push('admin');
  // good
  const next = { ...user, roles: [...user.roles, 'admin'] };
  ```

- **A `class` is only a thin dependency-holding shell at a composition root; methods delegate to pure functions.**

  ```ts
  // good
  class WalletService {
    constructor(
      private db: Db,
      private events: Bus,
    ) {}
    debit(input: DebitInput) {
      return debit(this.db, this.events, input);
    } // pure fn does the work
  }
  ```

- **No inheritance for code reuse - compose.** No decorators anywhere.

  ```ts
  // bad: class AdminUser extends User {}
  // good: const can = withPermissions(user, adminPolicy);
  ```

- **Short, single-purpose functions.** If you comment "// step 2" inside a function, extract it.

---

## 5. Comments and documentation

- **Comment WHY, never WHAT.** Delete comments that restate a name or the obvious line.

  ```ts
  // bad
  // increment the counter
  count++;

  // good
  // Stripe rounds half-to-even; mirror it so our totals reconcile.
  const rounded = bankersRound(amount);
  ```

- **Comment the non-obvious:** hidden constraint, invariant, bug workaround (link it), trade-off.
- **If a block needs a comment to be understood, rename/extract first.**

  ```ts
  // bad: a 20-line block prefaced by "// validate and normalize the address"
  // good: const address = normalizeAddress(validateAddress(raw));
  ```

- **No section-divider comments** (`// ---`, `// ===`).
- **A one-line JSDoc comment on every exported function/class that is >~15 lines or has
  non-obvious params.** One sentence; document the surprising contract, not the name.

  ```ts
  // bad - restates the name
  /** Returns the user. */
  export function getUser(id: string) { ... }
  // good - documents a genuinely surprising contract
  /** Returns null when the feed is rate-limited (caller should back off). */
  export function pollFeed(): FeedItem[] | null { ... }
  ```

- **Track deferred work with an issue reference, never a bare `TODO`.**

  ```ts
  // TODO: replace polling with the webhook once BE ships it
  ```

---

## 6. Structure and boundaries

(The enforced import graph - add-on/domain/engine zones, ports, cross-module comms - lives
in `overview` > Dependency rules and `clean-architecture`. The principles those encode:)

- **Module isolation - never import another module's internals.** Cross-module needs go
  through a command port, a domain event, or a shared contract.

  ```ts
  // bad: sportsbook reads wallet's tables directly
  // good: walletCommands.debit(tx, { userId, amount });  // a port the wallet owns
  ```

- **Dependency direction points inward:** router -> service -> contracts; engine never imports a domain.
- **Public API is the package/subpath entry, never a deep `dist/`/`src/` path.**

  ```ts
  // bad
  import { x } from '@oss/core/dist/server/db';
  // good
  import { DrizzleService } from '@oss/core/server';
  ```

- **No import cycles** - extract a shared module or move the type to a contracts package.

---

## 7. React SDK (`@oss/core/react` + domain `/react` subpaths)

This repo is **headless** - it ships no UI, no styling, no component library (those live in
the consumer). Only the SDK consumption layer (hooks, typed client, auth, realtime) lives
here. So the React rules reduce to:

- **Presentational/logic split applies to the consumer, not here** - the SDK ships hooks, not
  components. Each hook is one `useX` per concern returning a plain object.

  ```ts
  // good
  function usePlayerWallet(id: string) {
    const q = useQuery({ queryKey: ['wallet', id], queryFn: () => client.wallet.get(id) });
    return { wallet: q.data, isLoading: q.isLoading };
  }
  ```

- **Hand-write `useMemo`/`useCallback` in the SDK** wherever a returned value/function is part
  of a hook's stability contract. This is the OPPOSITE of the consumer-app rule: the consumer
  builds with the React Compiler, but it does NOT reprocess pre-built `node_modules`, so the
  SDK is not auto-memoized downstream. Keep hooks Rules-of-React compliant (pure render,
  stable returns) so the consumer's compiler can optimize the components that call them.

  ```ts
  // good - stable client the consumer can drop into deps
  const client = useMemo(() => createClient(baseUrl), [baseUrl]);
  ```

- **Server state is not client state** - key/cache/invalidate via the query lib, never a raw
  `useEffect(fetch)`.

---

## 8. State and side effects

- **Isolate side effects at the edges** (services, adapters, plugins, handlers), never in pure helpers.

  ```ts
  // bad: formatName() that also emits an event
  // good: formatName() pure; events emitted from the service after the DB commit
  ```

- **Server state is owned by the data layer** - don't shadow it in ad-hoc caches.

---

## 9. Error handling

- **Fail fast at boundaries with typed errors.**

  ```ts
  const input = CreateOrderSchema.parse(raw); // throws on bad input, early
  ```

- **No silent catches.**

  ```ts
  // bad
  try {
    await save();
  } catch {}
  // good
  try {
    await save();
  } catch (e) {
    logger.error({ e }, 'save failed');
    throw e;
  }
  ```

- **Typed, named error classes mapped to transport at the edge.** Use the shared factories
  (`makeNotFoundError`/`makeOwnershipError`/`makeConflictError`); the router's `mapErrors`
  keys off the exported class.

  ```ts
  export const WalletNotFoundError = makeNotFoundError('Wallet');
  ```

- **Money / critical paths are transactional and idempotent.** A DB guard, not just an
  `idempotencyKey`, for money jobs (at-least-once delivery).

  ```ts
  await db.transaction(async (t) => {
    if (await ledgerExists(t, idempotencyKey)) return;
    await insertLedger(t, { idempotencyKey, amount });
  });
  ```

---

## 10. Testing

- **Co-locate as `src/__tests__/<name>.test.ts` (Vitest).** Service tests use a vi-mocked Drizzle.

- **Test behaviour, not implementation - survive a safe refactor.**

  ```ts
  // bad: expect(service._cache.size).toBe(1)
  // good: expect(await service.get(id)).toEqual(user)
  ```

- **Cover new logic as part of the change** (unit for pure fns; include authz negatives).

  ```ts
  it('rejects a withdrawal above balance', async () => {
    await expect(withdraw({ balance: 10 }, 50)).rejects.toThrow(InsufficientFunds);
  });
  ```

- **Deterministic and isolated:** no shared mutable state, no real network, seedable data.

---

## 11. Dependencies and integrations

- **Pin exact versions (no `^`/`~`).**

  ```jsonc
  // bad: "zod": "^3.23.0"   good: "zod": "3.23.0"
  ```

- **No inline `fetch`/`axios` in module code** - third-party integrations are ports + adapters
  bound at the root, never an inline call.

  ```ts
  // good
  ctx.provide(KYC_ADAPTER, () => new SumsubKyc(env.SUMSUB_KEY));
  ```

- **Add a dependency deliberately** - prefer std lib / small packages; a few lines often beat a tree.

---

## 12. Git and delivery

- **Conventional commits.**

  ```
  feat(wallet): atomic debit command port
  fix(audit): guard double-record on retry
  ```

- **One MR = one concern; split unrelated changes.** Never bundle foreign changes - stage explicitly.

  ```bash
  # bad
  git add -A
  # good
  git add packages/core/src/wallet/service/wallet.service.ts
  ```

- **Green before review:** `pnpm verify` must pass; `pnpm regen` after any contract/schema change.
- **Branch off `dev`; never commit directly to `dev`/`stage`/`main`.** Promotion chain
  `dev -> stage -> main` + release tags. Never push without an explicit per-action "yes push".

  ```bash
  git switch -c feat/internal-wallet-command dev
  ```

- **MR description carries intent:** what / why / acceptance criteria / ticket link.

---

## 13. Enforcement (make the rules real)

Conventions that aren't checked rot. This repo already wires them - keep them green:

- **`pnpm verify`** = typecheck + unit tests + lint (oxlint) + module-shape + the whole-graph
  boundary/cycle gate (`pnpm boundaries`, dependency-cruiser).
- **Two-layer boundaries:** oxlint `oss-boundaries/*` (per-edit) + dependency-cruiser
  (whole-graph) - see `overview` > Dependency rules. Don't work around a violation; fix the import.
- **Pre-commit hook** runs `pnpm boundaries`; **CI** runs `pnpm verify` plus a no-drift check
  (re-runs drizzle-kit + the catalog generator, fails on an uncommitted diff).
- **Agent rules mirror this standard** - generated from `.rulesync/` via `pnpm sync:agents`.

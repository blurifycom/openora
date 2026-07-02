---
root: false
targets:
  - '*'
globs:
  - '**/*'
description: Engineering code conventions (TS, headless backend) - apply all of these to every change.
---

# Engineering Conventions

The portable code standard for this headless backend repo - stack-agnostic principles, then the
TS/backend specifics. Structure/DI/boundaries: `clean-architecture`. Async seams: `messaging-and-microservices`.
OSS naming, forbidden patterns, decision tree: `overview`. Keep this file portable (shared with the
consumer repo); put OSS-only rules elsewhere.

Each rule carries a short example: `// bad` is the smell, `// good` the convention.

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
  `as unknown as X` is the worst form - it turns off type-checking entirely. If a symbol
  needs a type (e.g. a DI token), give it one at the source (`createToken<T>()`), don't cast
  at every use site. Two sanctioned exceptions, and only these: **(1) test doubles** - route
  them through the `mock` / `mockDb` / `readPrivate` helpers (`packages/core/src/testing/mock.ts`)
  so the assertion lives in one audited place, never inline in a test; **(2) third-party
  type-inference boundaries** a library gives you no honest way to satisfy - keep it to one
  cast with a one-line `// Library boundary:` note saying why.

  ```ts
  // bad - hides a wrong/missing type
  const user = data as User;
  // bad - double-cast switches off the compiler
  const svc = { db } as unknown as DrizzleService;
  const TOKEN = SYMBOL as unknown as Token<Config>;
  // good - validate, or fix the source type/import
  const user = UserSchema.parse(data);
  const TOKEN = createToken<Config>('CONFIG'); // typed at the source
  const svc = mockDb(db); // test double, cast confined to the helper
  const ROLES = ['admin', 'player'] as const; // ok
  ```

- **Never use `!` non-null assertions - narrow or restructure so the value is provably present.**
  A `!` silences the exact check that would catch a null; if the value can be absent, handle it,
  and if it can't, model the data so the type already says so.

  ```ts
  // bad - asserts away a possible undefined
  const owner = usersById.get(order.userId)!;
  // good - narrow explicitly when it can be absent
  const owner = usersById.get(order.userId);
  if (!owner) throw new UserNotFoundError(order.userId);
  // good - or carry the value so a lookup isn't needed at all
  ```

- **Under `noUncheckedIndexedAccess`, reach for `.at()`, destructuring-with-defaults, or an
  explicit guard - never `arr[i]!`.** The index access is exactly where the bounds check belongs.

  ```ts
  // bad
  const first = parts[0]!.toUpperCase();
  // good
  const [first = ''] = parts;
  ```

- **`type` over `interface`** (lint-enforced).

  ```ts
  type Props = { title: string };
  ```

- **Type entity ids through their owning type, never a bare primitive.** Reference
  `User['id']`/`Wallet['id']` instead of `string` so the id's representation lives in one
  place - when it changes (eg `string` -> `number`), every signature follows automatically.

  ```ts
  // bad - the id shape is duplicated everywhere and silently rots if it changes
  function unblockUser(blockerId: string, blockedId: string) { ... }
  // good - one source of truth for what a user id is
  function unblockUser(blockerId: User['id'], blockedId: User['id']) { ... }
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

- **Don't annotate a return type TypeScript can infer** - the body is the single source of truth,
  so the type can't drift. Annotate the return type ONLY when:
  - inference can't (recursion), or
  - you deliberately widen/narrow, or
  - it's a **published SDK export consumed downstream with no re-checking seam** - `/react` hooks
    (in every module) + the typed client, and plain-value `/server` helpers/factories - where the
    explicit type IS the public contract. A consumer in another repo depends on that shape and
    nothing revalidates it, so an inferred return silently leaks a refactor as a breaking change
    while the build stays green here.

  Routers, service methods, contracts, schemas, and plugins stay inferred: a seam already re-checks
  them (oRPC validates each handler's output against its contract) or the type is an unspellable
  oRPC/Drizzle structure. Argument types always stay explicit.

  ```ts
  // bad - redundant annotation on an internal method that has to be kept in sync by hand
  async function unblockUser(id: User['id']): Promise<{ success: true }> {
    await this.repo.remove(id);
    return { success: true };
  }
  // good - internal/service method: inferred from the body (the router re-checks it vs the contract)
  async function unblockUser(id: User['id']) {
    await this.repo.remove(id);
    return { success: true };
  }
  // good - published SDK hook: the return type IS the public contract, so pin it
  function useAuth(): AuthState {
    const { data } = useQuery({ ... });
    return { user: data ?? null, isLoading, isAuthenticated: !!data };
  }
  ```

- **Named exports only - no default exports.**

  ```ts
  // bad
  export default function fetchInvoice() { ... }
  export default router;

  // good
  export function fetchInvoice() { ... }
  export const router = createRouter();
  ```

---

## 5. Comments and documentation

- **Default to zero comments.** Delete comments that restate a name or the obvious line. Only
  add one when the code isn't straightforward from reading it alone - it needs deeper
  architectural context (why this module, why this order, why not the obvious approach), or
  it's implicit (a hidden constraint, an invariant, a bug workaround - link it, a trade-off).

  ```ts
  // bad
  // increment the counter
  count++;

  // good
  // Stripe rounds half-to-even; mirror it so our totals reconcile.
  const rounded = bankersRound(amount);
  ```

- **If a block needs a comment to be understood, rename/extract first.**

  ```ts
  // bad: a 20-line block prefaced by "// validate and normalize the address"
  // good: const address = normalizeAddress(validateAddress(raw));
  ```

- **No section-divider comments** (`// ---`, `// ===`).
- **A JSDoc comment on every exported function/class that is >~15 lines or has
  non-obvious params.** Write it as a multiline `/** ... */` block (opening `/**` and
  closing `*/` on their own lines), not a single-line `/** ... */`. Document the surprising
  contract, not the name.

  ```ts
  // bad - restates the name
  /** Returns the user. */
  export function getUser(id: string) { ... }
  // bad - single-line block
  /** Returns null when the feed is rate-limited. */
  export function pollFeed(): FeedItem[] | null { ... }
  // good - multiline block documenting a genuinely surprising contract
  /**
   * Returns null when the feed is rate-limited (caller should back off).
   */
  export function pollFeed(): FeedItem[] | null { ... }
  ```

- **Track deferred work with `// TODO:` and known-broken code with `// FIXME:`** - both
  greppable, both carrying enough context (and an issue reference where one exists) to act on
  later without re-deriving why. `TODO` = not built yet; `FIXME` = built wrong, needs fixing.
  Never a bare `TODO`/`FIXME` with no explanation.

  ```ts
  // TODO: replace polling with the webhook once BE ships it (ABC-312)
  // FIXME: race - two admins approving the same withdrawal double-credit the player
  ```

- **Mark placeholder/sample data and stubbed-out behavior with a greppable `// mock:` comment**
  so throwaway code stays visible and easy to find for later cleanup.

  ```ts
  // mock: fixed rate until the FX adapter lands
  const rate = 1.08;
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
  import { x } from '@blurifycom/core/dist/server/db';
  // good
  import { DrizzleService } from '@blurifycom/core/server';
  ```

- **No import cycles** - extract a shared module or move the type to a contracts package.

---

## 7. React SDK (`@blurifycom/core/react` + domain `/react` subpaths)

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

- **Hand-write `useMemo`/`useCallback` in the SDK** wherever a returned value/function is part of a
  hook's stability contract - the OPPOSITE of the consumer-app rule. The consumer's React Compiler
  does NOT reprocess pre-built `node_modules`, so the SDK is not auto-memoized downstream. Keep hooks
  Rules-of-React compliant (pure render, stable returns) so the consumer's compiler can optimize callers.

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

- **Conventional commits - mandatory and enforced.** Every commit message MUST follow the
  [Conventional Commits](https://www.conventionalcommits.org/) spec. `commitlint` runs on
  every local commit (husky `commit-msg` hook) and in CI - a non-conforming message blocks
  the merge. Common types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `perf`.
  The **scope is not free-form**: `commitlint.config.cjs` enforces a `scope-enum` derived from
  the workspace - every `packages/*` and `packages/core/src/*` module dir, add-ons, apps, plus
  meta scopes (`ci`, `deps`, `rules`, `repo`, `tooling`, ...). An unlisted scope fails the lint;
  run `pnpm commitlint --from HEAD~1` to check, or omit the scope if none fits.

  ```
  feat(wallet): atomic debit command port
  fix(audit): guard double-record on retry
  chore(deps): bump zod to 3.24.0
  ```

- **One MR = one concern; split unrelated changes.** Never bundle foreign changes - stage explicitly.

  ```bash
  # bad
  git add -A
  # good
  git add packages/core/src/wallet/service/wallet.service.ts
  ```

- **Green before review:** `pnpm verify` must pass; `pnpm regen` after any contract/schema change.
- **Branch off `dev`; never commit directly to `dev`/`stage`.** Promotion chain
  `dev -> stage` + release tags. Never push without an explicit per-action "yes push".

  ```bash
  git switch -c feat/internal-wallet-command dev
  ```

- **MR description carries intent:** what / why / acceptance criteria / ticket key.
- **No sensitive/internal data in titles, descriptions, or commit messages.** They are the
  public-facing record. Reference a ticket by its bare key (`ABC-45`), never the URL. No
  Jira/Confluence/Slack/Notion links, dashboards, internal hostnames, secrets, tokens,
  customer/operator names, PII, or internal IPs. When in doubt, leave it out.

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

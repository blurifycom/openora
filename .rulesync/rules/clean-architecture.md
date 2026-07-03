---
root: false
targets:
  - '*'
description: Clean-architecture conventions - module layering, DI, ports-and-adapters, and the shared helpers to reuse instead of re-rolling.
globs:
  - 'packages/**'
  - 'extensions/**'
---

# Clean architecture

Settled conventions - don't reopen. Style: `conventions`. Here: structure + the syntax that prevents recurring mistakes.

## Module layering (`packages/core/src/<domain>/<module>/` or `packages/addons/<name>/src/`)

| Layer    | File                        | Holds                                                                                                                                                         | Must NOT hold                    |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| schema   | `schema/index.ts`           | Drizzle `pgTable`s (snake_case via `casing: 'snake_case'`; datetimes ALWAYS `timestamp({ withTimezone: true })`); row types via `$inferSelect`/`$inferInsert` | logic                            |
| contract | `contract/index.ts`         | oRPC route contract + req/res Zod schemas - the single source of wire truth, exported as the module's `/contract` subpath                                     | logic, transport wiring          |
| service  | `service/<name>.service.ts` | ALL business logic; emits events after DB commit; money in `db.transaction`                                                                                   | HTTP/transport knowledge         |
| router   | `router/index.ts`           | thin oRPC wiring: resolve caller, call service, `mapErrors`                                                                                                   | business rules, SSE plumbing     |
| plugin   | `plugin.ts`                 | DI wiring only: `ctx.provide(...)`, `ctx.routers.add(...)`                                                                                                    | logic                            |
| adapters | `adapters/<vendor>/`        | concrete impls of adapter ports (`packages/core/src/contracts/adapters/`)                                                                                     | being imported by another module |

Service methods are data-in/data-out; side effects (DB writes, event emits, adapter calls) at the edges.

## Dependency injection (no decorators, no reflect-metadata)

- Tokens are typed symbols: `createToken<T>('NAME')`, declared with the port in `packages/core/src/contracts/adapters/`.
- `Container` (`@blurifycom/core/server`) wires factories: `register(token, factory)` (last-wins = overlay rebind), `get(token)` (lazy singleton), `onDispose(fn)`.
- Services take deps by type via constructor; never touch the container. `plugin.ts` builds them: `ctx.routers.add('wallet', (c) => createWalletRouter(new WalletService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(PAYMENT_ADAPTER))))`.
- A dep captured in a closure is a smell - make it a port + token (canonical fix: `SEND_EMAIL` in identity).

## Ports & adapters (hexagonal)

Ports = interfaces + tokens in `packages/core/src/contracts/adapters/` (`PAYMENT_ADAPTER`, `KYC_ADAPTER`, `MESSAGE_BROKER`, `JOB_QUEUE`, `REALTIME_TRANSPORT`, `SEND_EMAIL`, ...). Adapters = impls in modules, bound in `plugin.ts`, swapped by a later-loading overlay re-`provide`ing the token. Services depend only on the port. A third-party integration is always a port + impl, never an inline `fetch`/SDK call.

## Cross-module communication (lint-enforced)

Sanctioned paths only: domain **events** (`EventBus`), **command ports** (a token the owner binds, eg `WALLET_COMMANDS`), shared **contracts**, read-only table reads via the owner's `/schema` subpath. Never import another module's internals (`no-cross-domain`/`no-cross-addon` = errors; `pnpm boundaries` is the whole-graph gate). ADR-0015.

Money + any needed-now mutation stay synchronous/transactional, never over events - use a command port: caller passes its own `tx` (`WALLET_COMMANDS.debit(tx, ...)`), atomic in-process yet splittable later; declare `dependsOn: ['<owner>']`. Cross-module schema reads are sanctioned but warned (`no-cross-addon-schema-read`) - each one is an extraction blocker. ADR-0017.

**Never write a deep (`../../`+) relative import that leaves your own top-level dir under `packages/core/src/` - reach every other zone through the package's own `@blurifycom/core/*` subpath.** A relative import is only for staying inside your own module/zone (`./schema/index.js`, `../db/index.js`). The moment a `..` would cross into another domain, slice, or engine zone, it's a `@blurifycom/core/*` import instead:

- reaching the contracts zone -> `@blurifycom/core/contracts` (never `../../contracts/...`)
- reaching engine helpers -> `@blurifycom/core/server` (never `../../../server/kernel/...`)
- reaching shared errors -> `@blurifycom/core/common/errors`
- a sibling domain's tables -> `@blurifycom/core/<domain>/schema` (never `../../<domain>/schema`)
- a sibling slice -> that slice's `@blurifycom/core/<domain>/<schema|contracts|plugins>/<slice>` subpath

Lint-enforced by `oss-module-shape/no-relative-zone-escape` (folded domains AND the contracts/server/react engine zones; only `scripts`/`common`/`testing` are exempt as the importing file). If a target has no subpath yet, add the export - don't reach for `../../../`.

## Database foreign keys - within a module only

`.references(...)` only between tables the SAME module owns (eg `chatMessage.roomId -> chatRoom.id`). A column pointing at another module's row (typically `userId`) stays a bare `uuid().notNull()` - no `.references`. A cross-module FK is unenforceable once tables split across services (ADR-0017), and Postgres doesn't auto-index the child column anyway. Cross-module integrity goes through a lifecycle event owners subscribe to - don't pre-wire orphan cleanup (users are deactivated, never hard-deleted).

## Reuse these shared helpers (do not re-roll)

| Need                                         | Use                                                                                             | From                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| first-row-or-throw                           | `findOneOrThrow(await db.select()..., new XNotFoundError(id))`                                  | `@blurifycom/core/server`    |
| page offset                                  | `pageToOffset(page, limit)`                                                                     | `@blurifycom/core/server`    |
| ownership guard                              | `assertOwnership(row.userId, callerId, error)`                                                  | `@blurifycom/core/server`    |
| row -> DTO (Date/Decimal -> string)          | `serializeRow(row, { dateFields: [...], decimalFields: [...] })`                                | `@blurifycom/core/server`    |
| not-found / ownership / conflict error class | `makeNotFoundError('Entity')` / `makeOwnershipError('Entity')` / `makeConflictError(name, msg)` | `@blurifycom/core/server`    |
| push subscription -> SSE async generator     | `createEventStreamGenerator((push) => svc.subscribe(push), { signal, prime })`                  | `@blurifycom/core/server`    |
| canonical id/userId/pagination input         | `IdInputSchema` / `UserIdInputSchema` / `PaginationInputSchema`                                 | `@blurifycom/core/contracts` |

Error factories keep the SAME exported const identifier (`export const WalletNotFoundError = makeNotFoundError('Wallet')`) - routers import the class and `mapErrors` keys off it.

## Testing

Co-locate as `__tests__/<name>.test.ts` (Vitest); service tests use a vi-mocked Drizzle (via the `mock`/`mockDb` helpers in `packages/core/src/testing/mock.ts`). Keep new logic covered.

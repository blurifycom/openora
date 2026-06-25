---
root: false
targets:
  - '*'
description: Clean-architecture conventions - module layering, DI, ports-and-adapters, and the shared helpers to reuse instead of re-rolling.
globs:
  - '**/*'
---

# Clean architecture

Settled conventions - don't reopen. Style/syntax: `overview.md` (pillar 7 + Forbidden patterns) + global rules. Here: structure + the syntax that prevents recurring mistakes.

## Add-on layering (`packages/addons/<name>/src/`)

| Layer    | File                        | Holds                                                                                                                                                                                                                 | Must NOT hold                    |
| -------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| schema   | `schema/index.ts`           | Drizzle `pgTable`s, snake_case SQL identifiers via `casing: 'snake_case'` (drop column name strings); datetimes ALWAYS `timestamp({ withTimezone: true })` = timestamptz; row types via `$inferSelect`/`$inferInsert` | logic                            |
| contract | `contract/index.ts`         | oRPC route contract + req/resp Zod schemas - the source of truth, exported `@blurifycom-addons/<name>/contract`                                                                                                       | logic, transport wiring          |
| schemas  | `schemas/index.ts`          | Zod input/output (mostly re-export `../contract` + shared-schemas)                                                                                                                                                    | ad-hoc inline schemas            |
| service  | `service/<name>.service.ts` | ALL business logic; emits events after DB commit; money in `db.transaction`                                                                                                                                           | HTTP/transport knowledge         |
| router   | `router/index.ts`           | thin oRPC wiring: `getUserId`, call service, `mapErrors`                                                                                                                                                              | business rules, SSE plumbing     |
| plugin   | `plugin.ts`                 | DI wiring only: `ctx.provide(...)`, `ctx.routers.add(...)`                                                                                                                                                            | logic                            |
| adapters | `adapters/<vendor>/`        | concrete impls of `@blurifycom/adapters` ports                                                                                                                                                                        | being imported by another add-on |

Service methods are data-in/data-out; side effects (DB writes, event emits, adapter calls) at the edges (rationale: `overview.md`).

## Dependency injection (no decorators, no reflect-metadata)

- Tokens are typed symbols: `createToken<T>('NAME')` in `@blurifycom/adapters`.
- `Container` (`@blurifycom/core`) wires factories: `register(token, factory)` (last-wins = overlay rebind), `get(token)` (lazy singleton), `onDispose(fn)`.
- Services take deps by INTERFACE via constructor; never touch the container. `plugin.ts` builds them: `ctx.routers.add('wallet', (c) => createWalletRouter(new WalletService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(PAYMENT_ADAPTER))))`.
- A dep captured in a closure is a smell - make it a port + token (canonical fix: `SEND_EMAIL` in identity).

## Ports & adapters (hexagonal)

Ports = interfaces + tokens in `@blurifycom/adapters` (`PAYMENT_ADAPTER`, `KYC_ADAPTER`, `MESSAGE_BROKER`, `JOB_QUEUE`, `REALTIME_TRANSPORT`, `SEND_EMAIL`, ...). Adapters = impls in modules, bound in `plugin.ts`, swapped by a later-loading overlay re-`provide`ing the token. Services depend only on the port. A third-party integration is always a port + impl, never an inline `fetch`/SDK call.

## Cross-add-on communication (lint-enforced)

Sanctioned paths only: domain **events** (`EventBus`), **command ports** (a `@blurifycom/adapters` token the owner binds, eg `WALLET_COMMANDS`), shared **contracts**, read-only table reads via `@blurifycom-addons/<name>/schema`. Never import another add-on's root/internals (`no-cross-addon-import`/`no-addon-internal-import` = errors). Gate: oxlint `oss-boundaries/*` + whole-graph `.dependency-cruiser.cjs` (`pnpm boundaries`). ADR-0015.

Money + any needed-now mutation stay synchronous/transactional, never over events - prefer a command port: caller passes its own `tx` (`WALLET_COMMANDS.debit(tx, ...)`), atomic in-process yet splittable later; declare `dependsOn: ['<owner>']`. `no-cross-addon-schema-read` warns on every cross-add-on schema import (sanctioned but a coupling/extraction blocker). ADR-0017.

## Database foreign keys - within a module only

`.references(...)` FKs only between tables the SAME module owns (eg `chatMessage.roomId -> chatRoom.id`). A column pointing at another module's row (typically `userId -> user.id`, owned by identity) stays a bare `uuid().notNull()` - no `.references` (match `chatMessage.userId` / `wallet.userId`). A FK is a correctness constraint, not a perf feature (indexes give read speed - Postgres doesn't auto-index the child column; FKs add write cost), and a cross-module FK is unenforceable once tables split across shards/services, blocking the ADR-0017 extraction invariant. Cross-module integrity goes through a lifecycle event (eg a future `identity.user.purged`) owners subscribe to - don't pre-wire orphan cleanup (YAGNI: users are deactivated, never hard-deleted; GDPR erasure is sealed).

## Explicit > magic

Every wiring point is a greppable call. No auto-discovery, no central adapter-default registry - each `plugin.ts` binds its own defaults. Named factory over clever abstraction.

## Reuse these shared helpers (do not re-roll)

| Need                                         | Use                                                                                             | From                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| first-row-or-throw                           | `findOneOrThrow(await db.select()..., new XNotFoundError(id))`                                  | `@blurifycom/db`             |
| page offset                                  | `pageToOffset(page, limit)`                                                                     | `@blurifycom/db`             |
| ownership guard                              | `assertOwnership(row.userId, callerId, error)`                                                  | `@blurifycom/core`           |
| row -> DTO (Date/Decimal -> string)          | `serializeRow(row, { dateFields: [...], decimalFields: [...] })`                                | `@blurifycom/core`           |
| not-found / ownership / conflict error class | `makeNotFoundError('Entity')` / `makeOwnershipError('Entity')` / `makeConflictError(name, msg)` | `@blurifycom/core`           |
| push subscription -> SSE async generator     | `createEventStreamGenerator((push) => svc.subscribe(push), { signal, prime })`                  | `@blurifycom/core`           |
| canonical id/userId/pagination input         | `IdInputSchema` / `UserIdInputSchema` / `PaginationInputSchema`                                 | `@blurifycom/shared-schemas` |

Error factories keep the SAME exported const identifier (`export const WalletNotFoundError = makeNotFoundError('Wallet')`) - routers import the class and `mapErrors` keys off it.

## Testing

Co-locate as `src/__tests__/<name>.test.ts` (Vitest); service tests use a vi-mocked Drizzle (ref: `compliance.service.test.ts`). Keep new logic covered.

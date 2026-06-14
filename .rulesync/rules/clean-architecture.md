---
root: false
targets:
  - '*'
description: Clean-architecture conventions - module layering, DI, ports-and-adapters, and the shared helpers to reuse instead of re-rolling.
globs:
  - '**/*'
---

# Clean architecture

Settled conventions - keep to them, do not reopen. Style/syntax rules live in `overview.md` (pillar 7 + Forbidden patterns) and global rules; this file is structure + the syntax that prevents recurring mistakes.

## Add-on layering (`packages/addons/<name>/src/`)

| Layer    | File                        | Holds                                                                       | Must NOT hold                    |
| -------- | --------------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| schema   | `schema/index.ts`           | Drizzle `pgTable`s, row types via `$inferSelect`/`$inferInsert`             | logic                            |
| contract | `contract/index.ts`         | the add-on's oRPC route contract + request/response Zod schemas - the source of truth, exported as `@oss-addons/<name>/contract` | logic, transport wiring          |
| schemas  | `schemas/index.ts`          | Zod input/output (mostly re-export from `../contract` + shared-schemas)      | ad-hoc inline schemas            |
| service  | `service/<name>.service.ts` | ALL business logic; emits events after DB commit; money in `db.transaction` | HTTP/transport knowledge         |
| router   | `router/index.ts`           | thin oRPC wiring: resolve caller (`getUserId`), call service, `mapErrors`   | business rules, SSE plumbing     |
| plugin   | `plugin.ts`                 | DI wiring only: `ctx.provide(...)`, `ctx.routers.add(...)`                  | logic                            |
| adapters | `adapters/<vendor>/`        | concrete impls of `@oss/adapters` ports                                     | being imported by another add-on |

Service methods are data-in/data-out; side effects (DB writes, event emits, adapter calls) at the edges. (Functional/declarative rationale: `overview.md`.)

## Dependency injection (no decorators, no reflect-metadata)

- Tokens are typed symbols: `createToken<T>('NAME')` in `@oss/adapters`.
- `Container` (`@oss/core`) wires factories: `register(token, factory)` (last-wins = the overlay rebind), `get(token)` (lazy singleton), `onDispose(fn)`.
- Services take deps by INTERFACE via constructor; never touch the container. `plugin.ts` builds them: `ctx.routers.add('wallet', (c) => createWalletRouter(new WalletService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(PAYMENT_ADAPTER))))`.
- A dep captured in a closure is a smell - make it an explicit port + token (canonical fix: the `SEND_EMAIL` seam in identity).

## Ports & adapters (hexagonal)

Ports = interfaces + tokens in `@oss/adapters` (`PAYMENT_ADAPTER`, `KYC_ADAPTER`, `MESSAGE_BROKER`, `JOB_QUEUE`, `REALTIME_TRANSPORT`, `SEND_EMAIL`, ...). Adapters = impls in modules, bound in `plugin.ts`, swapped by a later-loading overlay re-`provide`ing the token. Services depend only on the port. A third-party integration is always a port + impl, never an inline `fetch`/SDK call.

## Cross-add-on communication (lint-enforced)

Sanctioned paths only: domain **events** (`EventBus`), **command ports** (a `@oss/adapters` token the owner binds, eg `WALLET_COMMANDS`), shared **contracts**, and read-only table reads via `@oss-addons/<name>/schema`. Never import another add-on's root/internals (`no-cross-addon-import` / `no-addon-internal-import` = errors). Two-layer gate: oxlint `oss-boundaries/*` + whole-graph `.dependency-cruiser.cjs` (`pnpm boundaries`). See ADR-0015.

Money + any needed-now mutation stay synchronous/transactional - never over events. Prefer a command port: caller passes its own `tx` (eg `WALLET_COMMANDS.debit(tx, ...)`), atomic in-process yet splittable later; declare `dependsOn: ['<owner>']`. `no-cross-addon-schema-read` warns on every cross-add-on schema import - sanctioned but a coupling/extraction blocker. See ADR-0017.

## Explicit > magic

Every wiring point is a greppable call. No auto-discovery, no central adapter-default registry - each `plugin.ts` binds its own defaults. Named factory over clever abstraction.

## Reuse these shared helpers (do not re-roll)

| Need                                         | Use                                                                                             | From                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------- |
| first-row-or-throw                           | `findOneOrThrow(await db.select()..., new XNotFoundError(id))`                                  | `@oss/db`             |
| page offset                                  | `pageToOffset(page, limit)`                                                                     | `@oss/db`             |
| ownership guard                              | `assertOwnership(row.userId, callerId, error)`                                                  | `@oss/core`           |
| row -> DTO (Date/Decimal -> string)          | `serializeRow(row, { dateFields: [...], decimalFields: [...] })`                                | `@oss/core`           |
| not-found / ownership / conflict error class | `makeNotFoundError('Entity')` / `makeOwnershipError('Entity')` / `makeConflictError(name, msg)` | `@oss/core`           |
| push subscription -> SSE async generator     | `createEventStreamGenerator((push) => svc.subscribe(push), { signal, prime })`                  | `@oss/core`           |
| canonical id/userId/pagination input         | `IdInputSchema` / `UserIdInputSchema` / `PaginationInputSchema`                                 | `@oss/shared-schemas` |

Error factories keep the SAME exported const identifier (`export const WalletNotFoundError = makeNotFoundError('Wallet')`) - routers import the class and `mapErrors` keys off it.

## Testing

Co-locate as `src/__tests__/<name>.test.ts` (Vitest). Service tests use a vi-mocked Drizzle (`compliance.service.test.ts` is the reference). Keep new logic covered.

---
root: false
targets:
  - '*'
description: Clean-architecture conventions - module layering, DI, ports-and-adapters, and the shared helpers to reuse instead of re-rolling.
globs:
  - '**/*'
---

# Clean architecture

These are the conventions this repo already follows. Keep to them; do not reopen them.

## Module layering (one folder under `packages/modules/<group>/<name>/src/`)

| Layer    | File                        | Holds                                                                       | Must NOT hold                    |
| -------- | --------------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| schema   | `schema/index.ts`           | Drizzle `pgTable`s, row types via `$inferSelect`/`$inferInsert`             | logic                            |
| schemas  | `schemas/index.ts`          | Zod input/output (mostly re-export from `@oss/orpc-contract/<module>`)      | ad-hoc inline schemas            |
| service  | `service/<name>.service.ts` | ALL business logic; emits events after DB commit; money in `db.transaction` | HTTP/transport knowledge         |
| router   | `router/index.ts`           | thin oRPC wiring: resolve caller (`getUserId`), call service, `mapErrors`   | business rules, SSE plumbing     |
| plugin   | `plugin.ts`                 | DI wiring only: `ctx.provide(...)`, `ctx.routers.add(...)`                  | logic                            |
| adapters | `adapters/<vendor>/`        | concrete impls of `@oss/adapters` ports                                     | being imported by another module |

Service methods read as data-in/data-out transforms. Derive with `map`/`filter`/`reduce`; isolate side effects (DB writes, event emits, adapter calls) at the edges. Classes are fine for services/guards; keep their internals functional.

## Dependency injection (no decorators, no reflect-metadata)

- Tokens are typed symbols: `createToken<T>('NAME')` in `@oss/adapters`.
- The functional `Container` (`@oss/core`) wires factories: `register(token, factory)` (last registration wins - the overlay rebind mechanism), `get(token)` (lazy singleton), `onDispose(fn)`.
- Services receive deps by INTERFACE through their constructor; they never touch the container. `plugin.ts` builds the service: `ctx.routers.add('wallet', (c) => createWalletRouter(new WalletService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(PAYMENT_ADAPTER))))`.
- A hidden dependency captured in a closure is a smell - make it an explicit port + token (see the `SEND_EMAIL` seam in identity for the canonical fix).

## Ports & adapters (hexagonal)

Ports = interfaces + tokens in `@oss/adapters` (`PAYMENT_ADAPTER`, `KYC_ADAPTER`, `MESSAGE_BROKER`, `JOB_QUEUE`, `REALTIME_TRANSPORT`, `SEND_EMAIL`, ...). Adapters = concrete impls in modules, bound in `plugin.ts`, swapped by an overlay that loads later and re-`provide`s the token. Services depend only on the port. Add a third-party integration as a port + impl, never inline `fetch`/SDK calls.

## Cross-module communication (lint-enforced)

Sanctioned paths: domain **events** (`EventBus`), synchronous **command ports** (a `@oss/adapters` token the owning module binds, eg `WALLET_COMMANDS`), shared **contracts** (`@oss/shared-schemas` / oRPC), and read-only table reads via the `@oss/modules/<group>/<name>/schema` subpath. Never import another module's root or internals (`no-cross-module-import` / `no-module-internal-import` are errors). Enforcement is two-layer: the oxlint `oss-boundaries/*` plugin (per-file specifier strings) plus the whole-graph `.dependency-cruiser.cjs` gate (`pnpm boundaries`), which also catches transitive / re-export / dynamic-import / relative-path violations the string matcher misses. See AGENTS.md > Dependency rules and ADR-0015.

Money and any needed-now mutation stay synchronous/transactional. Prefer a **command port**: the consumer calls the owner's port passing its own `tx` handle (eg sportsbook -> `WALLET_COMMANDS.debit(tx, ...)`), so the write is atomic in-process AND the modules are decoupled enough to split later (a remote impl runs a saga). Declare `dependsOn: ['<owner>']`. The legacy in-`db.transaction` debit via the `/schema` subpath still works, but `no-cross-module-schema-read` now flags every cross-module schema import as a **warning** - it is a sanctioned-but-coupling extraction blocker; migrate writes to a command port and reporting reads to an event-fed read model before extracting a module to its own DB. Never move money over events. See ADR-0017.

## Explicit > magic

Every wiring point is a greppable function call. We deliberately do NOT auto-discover or centralize adapter defaults into a registry - each `plugin.ts` binds its own defaults explicitly. Prefer a named factory over a clever abstraction.

## Reuse these shared helpers (do not re-roll)

Before hand-writing a guard, mapper, or pagination math, use the platform helper:

| Need                                         | Use                                                                                             | From                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------- |
| first-row-or-throw                           | `findOneOrThrow(await db.select()..., new XNotFoundError(id))`                                  | `@oss/db`             |
| page offset                                  | `pageToOffset(page, limit)`                                                                     | `@oss/db`             |
| ownership guard                              | `assertOwnership(row.userId, callerId, error)`                                                  | `@oss/core`           |
| row -> DTO (Date/Decimal -> string)          | `serializeRow(row, { dateFields: [...], decimalFields: [...] })`                                | `@oss/core`           |
| not-found / ownership / conflict error class | `makeNotFoundError('Entity')` / `makeOwnershipError('Entity')` / `makeConflictError(name, msg)` | `@oss/core`           |
| push subscription -> SSE async generator     | `createEventStreamGenerator((push) => svc.subscribe(push), { signal, prime })`                  | `@oss/core`           |
| canonical id/userId/pagination input         | `IdInputSchema` / `UserIdInputSchema` / `PaginationInputSchema`                                 | `@oss/shared-schemas` |

Error factories keep the SAME exported const identifier (`export const WalletNotFoundError = makeNotFoundError('Wallet')`) because routers import the class and `mapErrors` keys off it.

## Testing

Co-locate as `src/__tests__/<name>.test.ts` (Vitest). Service tests use a vi-mocked Drizzle (`compliance.service.test.ts` is the reference). Platform primitives have their own unit tests. Keep new logic covered.

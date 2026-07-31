---
root: false
targets:
  - '*'
globs:
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.mjs'
description: Engineering code conventions (TS, headless backend) - apply to every code change.
---

# Engineering Conventions

The always-on core of the code standard: what you must obey while typing. Detail, examples and rationale live in `docs/standards/` - read the one file that matches the change instead of carrying all of it. Async seams: `messaging-and-microservices`. SQL / Drizzle: `db-conventions`, then `docs/standards/database.md`. Repo map, decision tree, dependency rules: `overview`.

| Change you are making                  | Read first                           |
| -------------------------------------- | ------------------------------------ |
| schema, type, enum-like value set      | `docs/standards/types.md`            |
| SQL, Drizzle, migration, seed, DB tool | `docs/standards/database.md`         |
| function, service method, constructor  | `docs/standards/functions.md`        |
| new module, DI wiring, integration     | `docs/standards/module-structure.md` |
| error class, catch, money path         | `docs/standards/errors.md`           |
| a test                                 | `docs/standards/testing.md`          |
| a comment or JSDoc                     | `docs/standards/comments.md`         |
| a hook / the typed client              | `docs/standards/react-sdk.md`        |
| commit, PR                             | `docs/standards/git-delivery.md`     |
| a failing gate, a new lint rule        | `docs/standards/enforcement.md`      |

## Philosophy

- **Functional and declarative by default.** Pure functions, immutable data, composition over imperative mutation and stateful classes.
- **Explicit over magic.** No auto-discovery, no decorator/reflection soup; every wiring point is a greppable, typed call.
- **Self-documenting.** Clear names beat comments.
- **Small and composable.** One concept per file; `parseUser()` + `sendWelcomeEmail()`, not `parseUserAndSendEmail()`.
- **YAGNI + DRY, in that order.** Abstract on the third occurrence, not the first.
- **Boring and consistent.** Match the surrounding code's idiom, naming, and density.

## Never (lint-enforced unless noted)

- `any` (tests included), `!` non-null assertions, `arr[i]!`, `as` casts to silence the compiler (`as const` is fine; test doubles go through the `mock` helper).
- `interface`, TS `enum`, decorators, inheritance for reuse, default exports (except `plugin.ts` + `drizzle.config.ts`).
- Hand-written duplicates of an inferrable type, re-inferring an imported schema, re-typing derived schema fields.
- Raw `z.uuid()` (use `UuidSchema`), inline `z.enum([...])` outside a contract dir.
- Inline `fetch`/`axios` in module code - third-party access is a port + adapter bound at the root.
- Comments. The only exception is a fact the code cannot contain (external-system behaviour, a spec constraint) and JSDoc on a public export. A rationale is not a fact - it goes in the commit or an ADR.
- Deep (`../../`+) relative imports that leave your zone/module, imports of another module's internals, import cycles, deep `dist/`/`src/` paths into another package.
- Hand-edited generated files: migrations, `docs/openapi.json`, `docs/catalog.json`, per-tool agent mirrors.

## Always

- **One source of truth per shape - infer, never hand-write:** `z.infer<typeof XSchema>`, `typeof x.$inferSelect`.
- **Schema-first at every boundary** (HTTP, config, env, events); validate once at the edge, trust the type after.
- **Enum-like sets are a values + schema + type triple on the contract surface**; `pgEnum` derives from the tuple.
- **Entity ids typed through their owning type** (`roleId: AdminRole['id']`, never a bare `string`).
- **Guard clauses first, main path last; brace every control statement; >3 params -> one named object.**
- **Construct objects by spread + override**, never a hand-copied field list.
- **Side effects at the edges**; events emit after the DB commit; money paths are transactional AND idempotent (a DB guard inside the transaction, not just an idempotency key).
- **Typed, named error classes** from the shared factories, mapped to transport in the router's `mapErrors`.
- **Cross-module coupling only via** a domain event, a command port, a shared contract, or a read-only `/schema` subpath.
- **Reuse the shared helpers** (`findOneOrThrow`, `pageToOffset`, `assertOwnership`, `serializeRow`, `createEventStreamGenerator`, `IdInputSchema`/`PageQuerySchema`) instead of re-rolling them - full table in `docs/standards/module-structure.md`.
- **Tests co-locate in `__tests__/`**; a file using `createTestDb`/`createTestRedis` is named `*.int.test.ts` (integration tier, needs docker pg + redis). Test behaviour, not the query builder; always cover authz negatives.
- **Pin exact dependency versions** (no `^`/`~`), and add a dependency deliberately.
- **Green before review:** `pnpm verify` passes, `pnpm regen` after any contract/schema change. Conventional commits, lowercase subject, one PR per concern. Never push without explicit confirmation.

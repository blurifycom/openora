---
root: false
targets:
  - '*'
globs:
  - '**/*'
description: Engineering code conventions (TS, DB, frontend, testing, git) - the always-on core, with a routing table to full detail in docs/standards/.
---

# Engineering conventions

The always-on core of the code standard: what you must obey while typing. Detail, examples, and
rationale live in `docs/standards/` - read the one file that matches the change instead of
carrying all of it. The enforced import graph lives in `oss-boundaries`; Playwright rules in
`e2e-conventions`.

| Change you are making                 | Read first                           |
| ------------------------------------- | ------------------------------------ |
| schema, type, enum-like value set     | `docs/standards/types.md`            |
| function, service method, constructor | `docs/standards/functions.md`        |
| new package, overlay, module layout   | `docs/standards/module-structure.md` |
| a comment or JSDoc                    | `docs/standards/comments.md`         |
| error class, catch, money path        | `docs/standards/errors.md`           |
| a test                                | `docs/standards/testing.md`          |
| commit, PR                            | `docs/standards/git-delivery.md`     |
| a failing gate, a new lint rule       | `docs/standards/enforcement.md`      |
| React/UI component, page, styling     | `docs/standards/frontend.md`         |
| SQL, Drizzle, migration, seed         | `docs/standards/database.md`         |

`docs/standards/frontend.md` doesn't apply to a headless/api-only repo - delete it (and its row
above) if this repo has no UI apps.

## Philosophy

- Functional and declarative: pure functions, immutable data, composition. No stateful classes, no
  imperative accumulation loops.
- Explicit over magic: no decorators, no auto-discovery, no reflection. Every wiring point is a
  greppable typed call (`ctx.provide(TOKEN, factory)`).
- Self-documenting: clear names beat comments (`percentChange`, not `d` + a comment).
- YAGNI then DRY: don't build for imagined futures; abstract on the third occurrence, not the
  first.
- Boring and consistent: match the surrounding code's idiom, naming, and density.

## Never (lint-enforced unless noted)

- `any` outside tests, `!` non-null assertions, `as` casts to silence the compiler (`as const` is
  fine).
- `interface`, TS `enum`, decorators, inheritance for reuse, default exports (exceptions:
  `*.config.*`, `plugin.ts`, Next.js App Router files).
- Hand-written duplicates of an inferrable type, re-inferring an imported schema, re-typing
  derived schema fields, ad-hoc/duplicated Zod schemas outside a module's `contract/`.
- Re-exporting types "to be nice" - import from where defined.
- Inline `fetch`/`axios` in module code - third-party access is a port + adapter bound at the
  composition root.
- Deep (`../../`+) relative imports that leave your module/zone, imports of another module's
  internals, import cycles, deep `dist/`/`src/` paths into another package.
- SQL anti-patterns (bare `timestamp()`, CamelCase identifiers, hand-edited migrations) - detail
  in `docs/standards/database.md`.

## Always

- **Naming:** files `kebab-case.ts`, one concept per file, filename names the concept
  (`wallet.service.ts`, never `helpers.ts`); types `PascalCase`; values/functions `camelCase`;
  true global constants `SCREAMING_SNAKE_CASE`; Zod schemas `<Name>Schema` with inferred type
  `<Name>`; booleans read as predicates (`isActive`, `canEdit`); money is a decimal string plus a
  `currency` field alongside it, never `amountCents`.
- **One source of truth per shape** - infer, never hand-write: `z.infer<typeof XSchema>`,
  `typeof x.$inferSelect`. Full detail: `docs/standards/types.md`.
- **Literal config arrays/objects (option lists, key sets) use `as const`**, not an explicit union
  type annotation - let TypeScript infer the literal types.
- **Schema-first at every boundary** (HTTP, config, env, events); validate once at the edge, trust
  the type after.
- **Entity ids typed through their owning type** (`playerId: Player['id']`), never a bare
  `string`.
- **Guard clauses first, main path last; more than 3 params -> one named object.** Detail:
  `docs/standards/functions.md`.
- **Construct objects by spread + override**, never a hand-copied field list.
- **Side effects at the edges**; money paths are transactional AND idempotent (a DB guard inside
  the transaction, not just an idempotency key). Detail: `docs/standards/errors.md`.
- **Typed, named error classes** from the shared factories, mapped to transport in the router's
  `mapErrors`.
- **Pin exact dependency versions** (no `^`/`~`); add a dependency deliberately - std lib or a few
  lines often beat a tree.
- **Tests co-locate in `__tests__/`**; test behaviour, not implementation; always cover authz
  negatives. Detail: `docs/standards/testing.md`.
- **Green before review:** `pnpm verify` passes. Conventional commits, lowercase subject, one PR
  per concern. Never push without explicit confirmation. Detail: `docs/standards/git-delivery.md`.

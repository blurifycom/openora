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
`e2e-conventions`; the always-on UI and SQL cores in `frontend-conventions` and `db-conventions`.

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
  fine). Two sanctioned casts: test doubles through one `mock<T>()` helper (never inline in a
  test), and a third-party inference boundary a library gives no honest way to satisfy (one cast,
  one-line `// Library boundary:` note).
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
- Silent catches - log with context and rethrow. `ORPCError.message` rendered to a player - UI copy
  keys off `.code` + typed `.data` through `t()`.
- Comments, unless one states a fact the code cannot contain (an external system's behaviour, a
  spec constraint); a reason goes in the commit or PR, never inline. Never in tests. Detail:
  `docs/standards/comments.md`.
- An in-process test that mocks the database, a repository, or a sibling service - found one in
  the diff, replace it with the API E2E, do not add to it.

## Always

- **Naming:** files `kebab-case.ts`, one concept per file, filename names the concept
  (`wallet.service.ts`, never `helpers.ts`); types `PascalCase`; values/functions `camelCase`;
  true global constants `SCREAMING_SNAKE_CASE`; Zod schemas `<Name>Schema` with inferred type
  `<Name>`; booleans read as predicates (`isActive`, `canEdit`); money is a decimal string plus a
  `currency` field alongside it, never `amountCents`; IO functions are verbs (`fetchInvoice`); names
  carry units and intent (`delayMs`, `maxRetries`).
- **One source of truth per shape** - infer, never hand-write: `z.infer<typeof XSchema>`,
  `typeof x.$inferSelect`. Full detail: `docs/standards/types.md`.
- **Literal config arrays/objects (option lists, key sets) use `as const`**, not an explicit union
  type annotation - let TypeScript infer the literal types.
- **Schema-first at every boundary** (HTTP, config, env, events); validate once at the edge, trust
  the type after.
- **Entity ids typed through their owning type** (`playerId: Player['id']`), never a bare
  `string`.
- **Guard clauses first, main path last; more than 3 params -> one named object** (a leading
  `tx` handle may stay positional). Always brace control statements, even one-liners (lint:
  `curly`). Detail: `docs/standards/functions.md`.
- **Construct objects by spread + override**, never a hand-copied field list.
- **Side effects at the edges**; money paths are transactional AND idempotent (a DB guard inside
  the transaction, not just an idempotency key). Detail: `docs/standards/errors.md`.
- **Typed, named error classes** from the shared factories, mapped to transport in the router's
  `mapErrors`.
- **Pin exact dependency versions** (no `^`/`~`); add a dependency deliberately - std lib or a few
  lines often beat a tree.
- **Test at the outermost tier that reaches the behaviour:** a UI journey -> browser E2E; an API
  route, an overlay, a vendor adapter, anything with SQL -> API E2E against real Postgres with the
  vendor stubbed at its HTTP boundary; a pure function -> a co-located unit test in `__tests__/`.
  Never fake a query builder and never let a spy assertion be the point of a test; always cover
  authz negatives. A new or changed route ships one API E2E spec
  (`apps/e2e/tests/api/<domain>/<scenario>.spec.ts`): happy path plus one hostile path
  (unauthorized, wrong owner, repeated call on a money path) - it is the acceptance artifact the
  review's request trace reads as proof. Detail: `docs/standards/testing.md`.
- **Green before review:** `/check` (typecheck + lint + unit tests) while iterating, `pnpm verify`
  (adds format, boundaries, build) before the PR. Conventional commits, lowercase subject (PR
  title too - a squash merge turns it into the commit), one PR per concern. Never push without
  explicit confirmation. The description carries what / why / acceptance criteria / bare ticket
  key - no test plan or CI checklist the pipeline already shows, no URLs, hostnames, secrets, or
  PII. Detail: `docs/standards/git-delivery.md`.
- **Fix the import, never work around a lint or boundary violation.** Agent rules are generated
  from `.rulesync/` via `pnpm gen:agents` - never hand-edit a generated file. Detail:
  `docs/standards/enforcement.md`.

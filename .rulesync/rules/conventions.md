---
root: false
targets:
  - '*'
globs:
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.mjs'
  - 'packages/**/schema/**'
  - 'packages/**/service/**'
  - 'packages/**/adapters/**'
  - 'packages/core/src/**/admin-*.ts'
  - 'packages/**/seed/**'
  - 'packages/**/drizzle/**'
  - 'packages/**/drizzle.config.ts'
  - 'packages/**/migrate.ts'
  - 'packages/core/src/server/db/**'
  - 'packages/testing/src/**'
  - 'tools/db/**'
description: Engineering conventions - compact universal baseline and routing to topical standards.
---

# Engineering conventions

Use pure, composable functions and explicit typed wiring. Match local naming and structure. Prefer clear names, guard clauses, immutable construction, and side effects at boundaries. Reuse an existing helper before adding one.

| Change                                                  | Read first                           |
| ------------------------------------------------------- | ------------------------------------ |
| schema, type, enum-like value set                       | `docs/standards/types.md`            |
| SQL, Drizzle, migration, seed, DB tool                  | `docs/standards/database.md`         |
| function, service method, constructor                   | `docs/standards/functions.md`        |
| module, DI wiring, integration, cross-module dependency | `docs/standards/module-structure.md` |
| error class or catch                                    | `docs/standards/errors.md`           |
| money movement or payment settlement                    | `docs/standards/money.md`            |
| wallet module surface or ledger invariant               | `docs/modules/wallet.md`             |
| deposit address, sweep, reconciliation, custody rules   | `docs/standards/custody.md`          |
| implementing or binding a payment/custody vendor        | `docs/adapters/`                     |
| KYC or responsible gambling                             | `docs/standards/compliance.md`       |
| audit production or consumption                         | `docs/standards/audit.md`            |
| async seam, event, job, or realtime                     | `messaging-and-microservices`        |
| test                                                    | `docs/standards/testing.md`          |
| comment or JSDoc                                        | `docs/standards/comments.md`         |
| prose doc, README, guide                                | `docs/standards/documentation.md`    |
| hook or typed client                                    | `docs/standards/react-sdk.md`        |
| commit or PR                                            | `docs/standards/git-delivery.md`     |
| failing gate or lint rule                               | `docs/standards/enforcement.md`      |

## Universal baseline

- Schema-first at trust boundaries. Infer types from their owning schema or row; do not hand-write duplicates.
- Literal config arrays/objects (option lists, key sets) use `as const`, not an explicit union type annotation - let TypeScript infer the literal types.
- No `any`, `interface`, decorators, reuse inheritance, suppressive casts, or default exports except `plugin.ts` and `drizzle.config.ts`.
- Keep third-party access behind an owning adapter port. Do not import another module's internals or create cycles.
- Do not hand-edit generated artifacts: migrations, `docs/catalog.json`, or per-tool agent mirrors.
- State-changing work is transactional where its standard requires it. Money work is also idempotent with a durable database guard inside that transaction.

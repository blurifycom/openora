# ADR-0027: Per-module migration history

**Date**: 2026-06-28
**Status**: Accepted

## Context

Core domains were folded into the single `@blurifycom/core` package (ADR-0025) and share one Postgres database. Until now they also shared one drizzle-kit migration journal: `packages/core/drizzle/migrations/`, produced by one central `drizzle.config.ts` that globbed every core domain's `schema/index.ts`.

That central journal was the only thing still coupling the core domains. Their code was already isolated - no domain imports a sibling's schema, no foreign key crosses a module boundary (ADR-0024, the `no-cross-domain` boundary, and the db-conventions FK rule), and every table is owned by exactly one module. Gated add-ons (sportsbook, aggregator, leaderboard) already owned their own journal + tracking table via `runMigrations` (ADR-0020), proving the per-module pattern works against the shared DB.

A shared journal across modules has real costs:

- **Extraction friction.** Lifting a domain into its own package (the ADR-0017 microservices invariant) meant surgically splitting a shared history.
- **It hides drift in the boundary.** drizzle-kit can only emit a foreign key when the referenced table is in the same config's schema input. A central config that globs everything will happily generate a cross-module FK - exactly the coupling the boundary rules forbid.
- **drizzle's migrator is timestamp-based, not hash-based.** It applies a journal entry when its `folderMillis` is newer than the max `created_at` in the tracking table. This is correct for one journal, but it is why each independent journal MUST have its own tracking table - a shared table would silently skip an older-timestamped module's pending migration once another module records a newer one.

## Decision

Every module owns its own migration history, co-located with its schema, while continuing to share one database.

- Each core module (and the engine `outbox`) has its own `drizzle.config.ts` next to its `schema/`, writing to a co-located `drizzle/migrations/` with its own tracking table `__drizzle_migrations_<id>` in the `drizzle` schema.
- Each module exports a `migrate()` (`@blurifycom/core/<module>/migrate`) that calls the shared `runMigrations` primitive with its folder + tracking table. The engine `outbox` set is owned by `@blurifycom/core/server/migrate`.
- `pnpm -F @blurifycom/core generate` (`scripts/generate-all.mjs`) discovers every `src/**/drizzle.config.ts` and runs `drizzle-kit generate` per module - a new module needs no central wiring, just a `drizzle.config.ts` next to its schema.
- `pnpm db:migrate:all` (`tools/migrate-all.mjs`) applies every set. Order is not load-bearing because no FK crosses a module boundary.
- Postgres extensions a module's index needs (eg `pg_trgm` for a GIN trgm index) are declared via the new `runMigrations({ extensions })` option, not hand-edited into a regenerated migration.
- The central `packages/core/drizzle/` history and central `drizzle.config.ts` are removed. Existing histories were regenerated fresh from current schema (acceptable pre-1.0; existing databases re-init).

## Consequences

**Positive:**

- A module's migration history travels with the module - extraction to its own package is a folder move, no history surgery.
- The module boundary is enforced at the DB layer: a cross-module FK can no longer be generated (drizzle-kit lacks the sibling table in its schema input).
- Each tracking table is isolated, so timestamp-based application is correct across independent journals.
- The per-module pattern is uniform: core domains, the engine outbox, and gated add-ons all use the same `runMigrations` shape.

**Negative / trade-offs:**

- More config files (one `drizzle.config.ts` + `migrate.ts` per module) and more journals to keep green; `generate-all` + `migrate-all` loop over them.
- Regenerating fresh dropped the linear central history; any database on the old central journal must re-init.
- Extension provisioning moved out of migration SQL into the `extensions` option - a module with an opclass index must remember to declare it.

**Neutral:**

- Still one database, one connection, one transaction boundary per migration. This ADR changes authoring/tracking granularity, not the deployment topology.
- Splitting a module's journal from the shared DB happens only when the DB itself splits; until then every set targets the same connection.

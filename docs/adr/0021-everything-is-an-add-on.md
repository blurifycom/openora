# ADR-0021: Everything is a standalone add-on package

**Date**: 2026-06-14
**Status**: Accepted; implemented.
**Relates to**: ADR-0020 (gated add-on editions and isolation), ADR-0002 (plugin system).

## Update (2026-06-14): contracts inverted - every add-on owns its contract

The original decision below kept CORE add-on route contracts in `@blurifycom/orpc-contract` (to avoid a core->add-on import) while only GATED add-ons owned an in-package `src/contract/` slice. That left a feature's contract in one package and its service/router in another - two locations for one source of truth.

This is now inverted so the model is uniform: **every add-on owns its contract in `src/contract/` (exported as `@blurifycom-addons/<name>/contract`)** - core and gated alike, structurally identical. `@blurifycom/orpc-contract` becomes a pure **aggregator**: it imports each core add-on's `/contract` slice, composes the single runtime `contract` the `@blurifycom/react` typed client links against, and re-exports their schemas for back-compat. It owns only `health` (not an add-on). Gated add-on contracts still merge conditionally in `apps/api` (`editions.ts`), so the default typed client carries no gated surface.

Consequence: this inverts the dependency - `@blurifycom/orpc-contract` (and transitively `@blurifycom/react`) now depends on the core add-on packages. A narrow carve-out lets the aggregator import the read-only `@blurifycom-addons/<name>/contract` subpath only (oxlint pins the exception to `orpc-contract`; dependency-cruiser exempts add-on `/contract` dirs). The cross-cutting `PlayerSchema` family moved to `@blurifycom/shared-schemas` (it is shared by the `profile` and `player-management` add-ons). The count below is now **13 core add-ons** (localization was removed - translations live in the frontend consumer).

The original decision text is retained below for the record.

## Context

Previously the platform had two tiers: "modules" (14 features colocated in `packages/modules/<group>/<name>/`, sharing one `@blurifycom/modules` package entry and central Drizzle migrations) and "add-ons" (4 optional `@blurifycom-addons/<name>` packages with own migrations, gated by `OSS_ADDONS`). The group folders (`player`, `backoffice`, `platform`) existed only as organizational structure in prose; the codebase had no way to cleanly add a NEW feature to core or distinguish packaging at build time.

The distinction created friction: adding a feature meant deciding "module or add-on?" with no clear path forward; modules and add-ons followed different packaging rules (shared vs. standalone `package.json`); and the central `@blurifycom/modules` package grew without bound while add-ons stayed frozen.

## Decision

**Every feature is a standalone `@blurifycom-addons/<name>` package under `packages/addons/<name>/`** (own `package.json`, `tsconfig.json`, `src/{schema,schemas,service,router,plugin}`). The platform no longer has "modules" - only add-ons (or "features" in prose).

Two tiers **by registration**, not by packaging:

1. **CORE add-ons** (14 features) - registered in `extensions.config.ts` with **no `kind` attribute** - always load, contracts stay in `@blurifycom/orpc-contract` (so the `@blurifycom/react` typed client and `@blurifycom/api-runtime` composition root don't import add-on packages), migrations in the central `packages/platform/db/drizzle.config.ts` (all core schemas under one history). This is the free/default build.

2. **GATED add-ons** (4 features: leaderboard, sportsbook, aggregator, player-management) - registered with **`kind: 'addon'`**, loaded only when listed in `OSS_ADDONS` allowlist, carry their own `src/contract/` slice and `drizzle.config.ts` + `migrations/`, never imported by core (enforced by `no-core-to-addon` lint).

Consequence: the composition root (`@blurifycom/api-runtime`) is now a **facade that knows about core add-on `/schema` subpaths ONLY** (for plugin host, DI container bootstrap). It does NOT import `@blurifycom-addons/<name>` roots or any gated add-on. The platform builds in two editions:

- OSS_ADDONS unset (default): loads 14 core add-ons, omits gated contracts and routes entirely.
- OSS_ADDONS=leaderboard,sportsbook,... (optional): adds gated contracts to the root oRPC export, loads their routes, runs their migrations.

## Consequences

### Packaging & structure

- New features start as `@blurifycom-addons/<name>` with own `package.json` (no need to decide "core or gated" upfront - default is core, opt-in to `kind: 'addon'` later).
- Groups (`player` / `backoffice` / `platform`) are **metadata only** - used in docs/roadmap to describe _which surface a feature serves_, not _where code lives_. The scaffold prompts for the name, not a group.
- All 18 add-on contracts index from `packages/contracts/orpc-contract/<name>.ts` (core) or `src/contract/<name>.ts` (gated).
- Core add-on migrations are **appended to a single history** in `packages/platform/db/migrations/`, so drift and ordering are a single-instance problem; gated add-ons have their own migration folders (each with `drizzle.config.ts`), so they can be extracted/versioned independently.

### Imports & cross-add-on talk

- Add-ons import each other ONLY via read-only `/schema` subpaths: `import { wallet } from '@blurifycom-addons/wallet/schema'`.
- Root imports: `@blurifycom-addons/<name>` is forbidden in `packages/{platform,contracts,sdks}/**` and `@blurifycom/api-runtime` (only allowed in `apps/*` composition roots, which load add-ons into `extensions.config.ts`).
- Events, command ports, and gated read-only schema subpaths remain the only sanctioned cross-add-on comms.
- Dependency rules renamed:
  - `no-cross-module` → `no-cross-addon`
  - `no-module-internal-import` → `no-addon-internal-import`
  - `no-app-into-module-internals` → `no-app-into-addon-internals`
  - New rule `no-core-to-addon` strictly forbids `packages/{platform,contracts,sdks}/**` importing `@blurifycom-addons/*` (breaks the "composition root is the add-on wiring boundary" invariant).

### Scaffolding

- `pnpm gen module <name>` now generates `packages/addons/<name>/` as a standalone core add-on (registered in `extensions.config.ts` with no `kind`, contract in `@blurifycom/orpc-contract`).
- `pnpm gen addon <name> --gated` (future) would register with `kind: 'addon'`, own contract slice, own migrations folder.
- For now, a gated add-on is scaffolded the same way and manually moved to `kind: 'addon'` in config + its migration folder created.

### Edition gates

- `apps/api/src/editions.ts` contains `OSS_ADDONS: ('leaderboard' | 'sportsbook' | 'aggregator' | 'player-management')[]` (env-driven, case-sensitive list).
- `createApp` filters `extensions.config.ts` by edition: skip entries with `kind: 'addon'` if not in `OSS_ADDONS`.
- OpenAPI + React client types are **edition-aware**: unset `OSS_ADDONS` emits routes + schemas for 14 core features only; set it includes gated contracts + routes.
- CI runs two matrix builds: one with OSS_ADDONS unset (default), one with all gated add-ons enabled (full platform).

### Migration & extraction

- A core add-on (free build) can be promoted to optional later:
  1. Move its `packages/addons/<name>` to a separate repo / npm package (or keep it checked in as a submodule).
  2. Add a `drizzle.config.ts` + `migrations/` folder if not already there.
  3. Change `kind` to `'addon'` in `extensions.config.ts` and move its contract to `src/contract/`.
  4. Update the root oRPC contract to conditionally include its slice (already done by edition gates).
  5. No module-internal code changes.

- The reverse (gated → core) involves moving migrations back to the central history, moving the contract to `@blurifycom/orpc-contract`, and registering with no `kind` - again, no module logic change.

## Rationale

- **Consistency.** Every feature is packaged and structured the same way - eliminates the "module vs. add-on" question.
- **Extraction-ready by default.** Each add-on is a standalone `package.json` from day one, so extracting it later is _moving a folder + rewiring config_, not a rewrite.
- **Edition control at one point.** Composition root and config are the only places that know about gated add-ons; module code is unchanged.
- **Decoupling core composition.** `@blurifycom/api-runtime` does not import add-on packages (only their schemas, via subpath), so adding a new add-on does NOT trigger a rebuild of the composition root.
- **Simpler mental model for consumers.** "It's all add-ons; some are free, some are gated" is clearer than "modules + add-ons are different" and gives a clear path for new features.

## References

- ADR-0002 - plugin system and `definePlugin` (the mechanism that makes this work).
- ADR-0020 - gated add-on editions (predates this ADR; both are part of the same "add-on tier" story).
- ADR-0017 - extraction readiness and command ports (how add-ons decouple from each other).

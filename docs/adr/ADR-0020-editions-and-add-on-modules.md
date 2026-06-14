# ADR-0020: Editions and add-on (extract-later) modules

**Date**: 2026-06-12
**Status**: Accepted; implemented.
**Relates to**: ADR-0009 (oRPC + Hono + functional container), ADR-0015 (boundary lint), ADR-0017 (extraction-readiness manifest/outbox/command ports).

## Context

We want a lean default open-source distribution that excludes certain modules
(admin PAM, and other specialized verticals) and ships them as separate,
opt-in add-on packages anyone can install and enable. The modules stay in this
monorepo for now, but must be **completely isolated** so lifting one into its own
published npm package later is a move, not a refactor.

Code boundaries were already clean (no module imports another module's code; talk
goes through events/contracts/command ports). The blockers to extraction were
purely packaging:

1. All feature modules compiled into the single `@oss/modules` package - an add-on
   module could not be a paywalled subpath.
2. The root contract `@oss/orpc-contract` statically imported every module's slice,
   and each module's router did `implement(contract.<slice>)` against it. Removing a
   module broke the contract build.
3. Migrations were centralized in one drizzle history - an add-on module's tables
   were baked into the shared log.

## Decision

An add-on module is a **real standalone workspace package** under
`packages/addons/<name>/` named `@oss-addons/<name>`, shaped exactly like its
eventual published form:

- Own `package.json` + `tsconfig.json` (extends `@oss/tsconfig/node-service.json`).
- Own contract slice in `src/contract/` (moved OUT of `@oss/orpc-contract`); the
  router does `implement(localContract)`. The slice is populated in place
  (`populateContractRouterPaths`) so it is self-contained.
- Owns its tables in `src/schema/` with its **own** `drizzle.config.ts` ->
  `drizzle/migrations/` tracked in a dedicated `__drizzle_migrations_addon_<name>`
  table (never collides with core or sibling add-on history). An add-on module that
  owns no tables (e.g. player-management, which reads the core `player` table) has no
  drizzle config.
- Plain `definePlugin` in `src/plugin.ts` - identical to a core module plugin, so it
  is portable as-is.

Add-on modules may import core (`@oss/contracts/*`, `@oss/adapters`,
`@oss/platform/*`, `@oss/modules/<g>/<n>/schema`) exactly like a core module. They
may **not** import a sibling add-on package.

### The isolation guarantee (two-layer boundary gate)

Mirroring the existing pattern (oxlint specifier twin + dependency-cruiser whole
graph):

- `no-core-to-addon`: nothing under `packages/{modules,platform,contracts,sdks}/`
  may import `@oss-addons/*`. Only composition roots under `apps/*` may.
- `no-cross-addon`: an add-on package may not import another add-on package.

Because core can never reference add-on, removing/extracting a
`packages/addons/*` folder can never break core's typecheck, build, or boundaries.
That is the guarantee, enforced by CI.

### Composition root wiring (apps/api)

The free core contract (`@oss/orpc-contract`) carries no add-on slice. The
composition root composes editions in `apps/api/src/editions.ts`:

- A single registry maps each add-on plugin id to its `{ namespace, contract }`.
- `OSS_ADDONS` selects the enabled set: unset -> all available (dev/monorepo "full"
  edition); `""`/`none` -> none (the default build); `*`/`all` -> all; `a,b` -> subset.
- `applyEdition()` drops `kind:'addon'` entries that are not enabled, so their
  plugins never load and their routes are never served.
- `withAddonContracts()` merges the enabled slices into the contract passed to
  `createApp`, so the emitted OpenAPI advertises exactly the routes served.

`extensions.config.ts` lists add-on entries with `kind: 'addon'`.

When an add-on module is extracted to its own repo, the downstream consumer
`pnpm add`s it and performs the identical one-line registry + extensions wiring.
Nothing inside the package changes.

### admin PAM split (the one non-mechanical conversion)

`player-management` mixed admin PAM (`player.*`) with player self-profile
(`profile.*`). The split:

- The `player` table + the self-profile surface moved to a new **core** module
  `packages/modules/player/profile/` (every edition has players). The `profile`
  contract slice + the shared `PlayerSchema`/`PlayerStatusSchema`/`KycStatusSchema`
  stay in core `@oss/orpc-contract`.
- The admin surface moved to `@oss-addons/player-management`, which reads the core
  `player` table via `@oss/modules/player/profile/schema` (add-on -> core) and owns
  the admin `playerContract` (importing the shared player schemas from core).

## Migrations (the sensitive step)

Each add-on package owns its migration history in its own folder + tracking table.
A unified runner (`tools/migrate-all.mjs`) applies the core set then each present
add-on set.

The current committed central history (migrations 0000-0015) still contains the
CREATE statements for the now-add-on tables (leaderboard, sportsbook, aggregator).
Activating the per-package add-on migrations requires a one-time **re-baseline**:
run `pnpm regen` to let drizzle-kit emit a central migration that DROPs the add-on
tables from the core schema (they leave the core globs), review it, and let the
add-on baselines own them going forward. Because the platform is pre-1.0 with a
deterministic, idempotent `pnpm seed`, the local path is a DB reset
(`docker compose down -v` && `pnpm regen && pnpm db:migrate:all && pnpm seed`). No
history is rewritten. This re-baseline is deferred and must be reviewed before
applying - the add-on baseline migration files are staged but not yet applied.

## Consequences

- Shipping the default build = build with `OSS_ADDONS=none` (or omit the add-on
  `extensions.config` entries). No add-on code is referenced by core.
- Extracting a module = publish `packages/addons/<name>/`, move one registry line +
  one extensions entry into the consumer. No code change inside.
- The core SDK (`@oss/react`) no longer ships add-on hooks/prefetchers (PAM
  admin hooks, sportsbook prefetcher). A consumer that enables a module builds those
  against the merged contract.
- Adding/removing a module from the add-on set is a config change (the registry +
  extensions entry + boundary stays), not an architectural one.

# ADR-0020: Editions and premium (extract-later) modules

**Date**: 2026-06-12
**Status**: Accepted; implemented.
**Relates to**: ADR-0009 (oRPC + Hono + functional container), ADR-0015 (boundary lint), ADR-0017 (extraction-readiness manifest/outbox/command ports).

## Context

We want to ship a free open-source edition that excludes certain modules (admin
PAM, and other sellable verticals) and offer those as paid add-ons. The modules
stay in this monorepo for now, but must be **completely isolated** so lifting one
into its own published npm package later is a move, not a refactor.

Code boundaries were already clean (no module imports another module's code; talk
goes through events/contracts/command ports). The blockers to extraction were
purely packaging:

1. All feature modules compiled into the single `@oss/modules` package - a premium
   module could not be a paywalled subpath.
2. The root contract `@oss/orpc-contract` statically imported every module's slice,
   and each module's router did `implement(contract.<slice>)` against it. Removing a
   module broke the contract build.
3. Migrations were centralized in one drizzle history - a premium module's tables
   were baked into the shared log.

## Decision

A premium module is a **real standalone workspace package** under
`packages/premium/<name>/` named `@oss-premium/<name>`, shaped exactly like its
eventual published form:

- Own `package.json` + `tsconfig.json` (extends `@oss/tsconfig/node-service.json`).
- Own contract slice in `src/contract/` (moved OUT of `@oss/orpc-contract`); the
  router does `implement(localContract)`. The slice is populated in place
  (`populateContractRouterPaths`) so it is self-contained.
- Owns its tables in `src/schema/` with its **own** `drizzle.config.ts` ->
  `drizzle/migrations/` tracked in a dedicated `__drizzle_migrations_premium_<name>`
  table (never collides with core or sibling premium history). A premium module that
  owns no tables (e.g. player-management, which reads the core `player` table) has no
  drizzle config.
- Plain `definePlugin` in `src/plugin.ts` - identical to a core module plugin, so it
  is portable as-is.

Premium modules may import core (`@oss/contracts/*`, `@oss/adapters`,
`@oss/platform/*`, `@oss/modules/<g>/<n>/schema`) exactly like a core module. They
may **not** import a sibling premium package.

### The isolation guarantee (two-layer boundary gate)

Mirroring the existing pattern (oxlint specifier twin + dependency-cruiser whole
graph):

- `no-core-to-premium`: nothing under `packages/{modules,platform,contracts,sdks}/`
  may import `@oss-premium/*`. Only composition roots under `apps/*` may.
- `no-cross-premium`: a premium package may not import another premium package.

Because core can never reference premium, removing/extracting a
`packages/premium/*` folder can never break core's typecheck, build, or boundaries.
That is the guarantee, enforced by CI.

### Composition root wiring (apps/api)

The free core contract (`@oss/orpc-contract`) carries no premium slice. The
composition root composes editions in `apps/api/src/editions.ts`:

- A single registry maps each premium plugin id to its `{ namespace, contract }`.
- `OSS_PREMIUM` selects the enabled set: unset -> all available (dev/monorepo "full"
  edition); `""`/`none` -> none (the free edition); `*`/`all` -> all; `a,b` -> subset.
- `applyEdition()` drops `kind:'premium'` entries that are not enabled, so their
  plugins never load and their routes are never served.
- `withPremiumContracts()` merges the enabled slices into the contract passed to
  `createApp`, so the emitted OpenAPI advertises exactly the routes served.

`extensions.config.ts` lists premium entries with `kind: 'premium'`.

When a premium module is extracted to its own repo, the downstream consumer
`pnpm add`s it and performs the identical one-line registry + extensions wiring.
Nothing inside the package changes.

### admin PAM split (the one non-mechanical conversion)

`player-management` mixed admin PAM (`player.*`) with player self-profile
(`profile.*`). The split:

- The `player` table + the self-profile surface moved to a new **core** module
  `packages/modules/player/profile/` (every edition has players). The `profile`
  contract slice + the shared `PlayerSchema`/`PlayerStatusSchema`/`KycStatusSchema`
  stay in core `@oss/orpc-contract`.
- The admin surface moved to `@oss-premium/player-management`, which reads the core
  `player` table via `@oss/modules/player/profile/schema` (premium -> core) and owns
  the admin `playerContract` (importing the shared player schemas from core).

## Migrations (the sensitive step)

Each premium package owns its migration history in its own folder + tracking table.
A unified runner (`tools/migrate-all.mjs`) applies the core set then each present
premium set.

The current committed central history (migrations 0000-0015) still contains the
CREATE statements for the now-premium tables (leaderboard, sportsbook, aggregator).
Activating the per-package premium migrations requires a one-time **re-baseline**:
run `pnpm regen` to let drizzle-kit emit a central migration that DROPs the premium
tables from the core schema (they leave the core globs), review it, and let the
premium baselines own them going forward. Because the platform is pre-1.0 with a
deterministic, idempotent `pnpm seed`, the local path is a DB reset
(`docker compose down -v` && `pnpm regen && pnpm db:migrate:all && pnpm seed`). No
history is rewritten. This re-baseline is deferred and must be reviewed before
applying - the premium baseline migration files are staged but not yet applied.

## Consequences

- Shipping the free edition = build with `OSS_PREMIUM=none` (or omit the premium
  `extensions.config` entries). No premium code is referenced by core.
- Selling/extracting a module = publish `packages/premium/<name>/`, move one registry
  line + one extensions entry into the consumer. No code change inside.
- The core SDK (`@oss/react-hooks`) no longer ships premium hooks/prefetchers (PAM
  admin hooks, sportsbook prefetcher). A consumer that licenses a module builds those
  against the merged contract.
- Adding/removing a module from the premium set is a config change (the registry +
  extensions entry + boundary stays), not an architectural one.

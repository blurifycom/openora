# player-management - AGENTS.md (add-on package)

## What this is

`@oss-addons/player-management` - the **add-on** admin Player Account Management
(PAM) surface. NOT part of the default OSS build; the composition root loads it only
when `player-management` is in the `OSS_ADDONS` allowlist (see
`apps/api/src/editions.ts`). Structurally a plain `definePlugin`, so it lifts into
its own npm package with no code change. See `docs/adr/ADR-0020-editions-and-add-on-modules.md`.

It owns **no tables**. The `player` table lives in the core `profile` module
(`packages/modules/player/profile/`); this package reads it via the
`@oss/modules/player/profile/schema` subpath (an add-on->core read, allowed).

## Surface

- Exposes the `player.*` oRPC contract (admin/PAM): `list`, `get`, `update`,
  `remove`, `registrationsOverTime`, `summary`. The contract slice lives in
  `src/contract/` (imports the shared `PlayerSchema`/`PlayerStatusSchema`/
  `KycStatusSchema` from core `@oss/orpc-contract`).
- Every route is **admin-gated** via the platform `AdminGuard` (`@oss/auth`):
  `list`/`get` -> `player:view`, `update` -> `player:update`, `remove` ->
  `player:ban`, `registrationsOverTime`/`summary` -> `analytics:view`.

## Actor model

One auth realm (`user`, identity module) with a `role` discriminator. `role=player`
= end users (no PAM access); `role=admin` = back-office/PAM operators. A `Player` row
is the igaming-side profile for a player-role user.

## Do

- Add admin business logic to `src/service/player.service.ts`; admin route shapes to
  `src/contract/`.
- Read the core `player`/`user` tables only via their `/schema` subpaths.

## Don't

- Import another add-on package (`no-cross-addon`).
- Cause any core package to import this one (`no-core-to-addon` blocks it).
- Re-add the player self-profile here - that is the free core `profile` module.

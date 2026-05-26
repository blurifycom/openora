# @oss/module-player-management

Player Account Management (PAM). Owns the casino `Player` profile - the operator-facing record for an end user - and the admin API to list, view, update, and delete players, plus registration analytics for the players dashboard.

## What it does

- Owns the `player` table: a casino profile (displayName, country, currency, language, lifecycle status, KYC status, level, lifetime stats) linked to an identity `user` by `userId` (ID reference only, no cross-module FK).
- Exposes the `player.*` oRPC contract (admin/PAM surface): `list`, `get`, `update`, `remove`, `registrationsOverTime`, `summary`.
- Every route is **admin-gated**: `PlayerService.assertAdmin(headers)` resolves the better-auth session and rejects callers whose `user.role !== 'admin'`. igaming separates the player realm from operator staff.

## Actor model

The platform has one auth realm (`user`, identity module) with a `role` discriminator:

- `role = "player"` (default) - end users. They do not have PAM access.
- `role = "admin"` - back-office / PAM operators.

A `Player` row is the casino-side profile for a player-role user. Admins manage players through PAM; they are not themselves players.

## Extension points

- The players dashboard and detail pages live in `@oss/react-sdk` (`PlayersDashboardPage`, `PlayersListPage`, `PlayerDetailPage`). Plugins extend the player detail page via the `playerDetail` UI slots (`ctx.playerDetail.sections` / `.actions`) - see ADR-0006. Consumer's `player-badges` plugin is the reference consumer (it adds a "Badges" section to the player detail page).
- No vendor adapters today. KYC/AML provider integration would be added as an adapter in `@oss/adapters` (a `KycAdapter` already exists there).

## Ports

None yet.

## Do / Don't

- DO keep `userId` an ID reference (a plain `text` column, no cross-module FK) - modules must not hold cross-module FK relations. `.references(() => table.id)` is fine for FKs within this module only.
- DO gate every PAM route through `assertAdmin`.
- DO add lifecycle/KYC values to the Zod enums in `@oss/orpc-contract/player`, not as free strings.
- DON'T import the identity module's service/runtime. Read the `user` table by its schema subpath (`import { user } from '@oss/modules/platform/identity/schema'`) for email/role, or go through events.
- DON'T put player-specific business UI (badges, VIP, etc.) in this module - those are extensions.

## Files

- `src/schema/index.ts` - the `player` Drizzle `pgTable` (money columns `totalWagered` / `totalDeposits` are `decimal(...)` - strings in TS, read with `Number(...)`).
- `schemas/index.ts` - re-exports + `z.infer` types from the contract slice.
- `service/player.service.ts` - CRUD + stats + `assertAdmin` (injects `DrizzleService` from `@oss/db`). Domain errors: `PlayerNotFoundError`, `ForbiddenError`.
- `router/index.ts` - oRPC controller implementing `contract.player`, admin-gated.
- `plugin.ts` - registers service + controller.

## Migration

Schema changes ship a migration: edit `src/schema/index.ts`, then run `pnpm regen` (drizzle-kit generate) to produce the migration and apply it.

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=player-management` shows the new/changed route(s) (e.g. `player.list`).
- No `boundaries/dependencies` lint errors (no cross-module code imports; read other modules' tables only via the `@oss/modules/<group>/<name>/schema` subpath).
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.

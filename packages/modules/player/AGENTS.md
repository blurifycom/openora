# @oss/module-player

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
- No vendor ports today. KYC/AML provider integration would be added as a `service/ports.ts` port.

## Ports

None yet.

## Do / Don't

- DO keep `userId` an ID reference (no Prisma `@relation` to `user`) - modules must not hold cross-module FK relations.
- DO gate every PAM route through `assertAdmin`.
- DO add lifecycle/KYC values to the Zod enums in `@oss/orpc-contract/player`, not as free strings.
- DON'T import the identity module. Read the `user` table directly (shared DB) for email/role, or go through events.
- DON'T put player-specific business UI (badges, VIP, etc.) in this module - those are extensions.

## Files

- `prisma.partial.prisma` - the `player` table.
- `schemas/index.ts` - re-exports + `z.infer` types from the contract slice.
- `service/player.service.ts` - CRUD + stats + `assertAdmin`. Domain errors: `PlayerNotFoundError`, `ForbiddenError`.
- `router/index.ts` - oRPC controller implementing `contract.player`, admin-gated.
- `plugin.ts` - registers service + controller.

## Migration

Schema changes ship a migration: after `pnpm regen`, run `pnpm -F @oss/infra exec prisma migrate dev --name <change>`.

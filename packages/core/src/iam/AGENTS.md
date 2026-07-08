# iam module

Identity & Access Management for the backoffice. Provides dynamic DB-backed RBAC
(a `(role x module) -> level` matrix), super-admin semantics, 15
predefined roles, and admin onboarding via invitation tokens.

## What it does

Owns roles, the per-module permission-level matrix, user-to-role assignments, and
invitation tokens. Binds `ADMIN_PERMISSION_RESOLVER` so `AdminGuard` authorizes
against DB grants instead of static roles when a user has an assignment row - the
resolver EXPANDS each stored `(module, level)` cell into the action grants the 30
`AdminGuard.assert(ctx, resource, action)` call sites check, so the guard and those
call sites are untouched by the level model. Sends invitation emails via the
`SEND_EMAIL` port and emits `iam.invitation.accepted` plus the `iam.role.*` audit
events.

## The level model

Three levels, totally ordered: `no_access` < `read` < `read_write`. A role's matrix
is `permissions: Array<{ resource, level }>` and stores only non-`no_access` cells
(sparse - a missing module means `no_access`; deleting a row downgrades to
`no_access`). Levels live in `@openora/core/server` (`permission-levels.ts`):

| Helper                           | Purpose                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `levelToActions(resource, lvl)`  | Expand a cell to better-auth actions (the authz bridge)              |
| `actionsToLevel(resource, [..])` | Read-back: collapse a concrete action set to its level (legacy/edge) |
| `readActions[resource]`          | The READ action set; `['view']` by default, `[]` for `content`       |
| `isLevelSufficient(have, req)`   | Ordered comparison (used by the no-escalation check)                 |

`content` has no `view` action -> it is read-or-nothing (`read` expands to `[]`).
For single-action modules (`report`, `analytics`) `read` and `read_write` expand
identically.

## Layout (`packages/core/src/iam/`)

| Layer    | File                     | Holds                                                                       |
| -------- | ------------------------ | --------------------------------------------------------------------------- |
| schema   | `schema/index.ts`        | Drizzle `pgTable`s + row types (`$inferSelect`); datetimes are timestamptz. |
| contract | `contract/index.ts`      | the oRPC contract slice + level-based DTOs                                  |
| schemas  | `schemas/index.ts`       | re-exports from the contract slice; module-local Zod only                   |
| service  | `service/iam.service.ts` | ALL business logic; emits events after DB commit                            |
| router   | `router/index.ts`        | thin oRPC wiring: resolve caller, call service, `mapErrors`                 |
| plugin   | `plugin.ts`              | DI wiring only: `ctx.routers.add(...)`, `ctx.provide(...)`                  |

Contract slice: `@openora/core/iam/contract`.

## Extension points

| Point                        | How                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Override email sender        | `ctx.provide(SEND_EMAIL, ...)` in an overlay loaded after this module                                                                                        |
| React to accepted invitation | `ctx.events.on('iam.invitation.accepted', handler)` in an overlay                                                                                            |
| Add permission modules       | Edit `packages/core/src/server/auth/permissions.ts` `statement` - catalog, levels, validation derive                                                         |
| Change default roles         | Edit `DEFAULT_ADMIN_ROLES` (`iam/seed/default-admin-roles.ts`) and re-run the seeder (`seedRoles`, `@openora/core/iam/seed`); migrations stay structure-only |

## Ports consumed / provided

| Interface                 | Token                       | Purpose                               |
| ------------------------- | --------------------------- | ------------------------------------- |
| `SendEmailPort`           | `SEND_EMAIL`                | Deliver invitation emails             |
| `DrizzleService`          | `DRIZZLE`                   | All DB reads/writes                   |
| `EventBus`                | `EVENT_BUS`                 | Emit `iam.*` events                   |
| `AdminGuard`              | `ADMIN_GUARD`               | Guard every admin route               |
| `AdminPermissionResolver` | `ADMIN_PERMISSION_RESOLVER` | Provided: `DbAdminPermissionResolver` |

## Tables

| Table                   | Description                                                                      |
| ----------------------- | -------------------------------------------------------------------------------- |
| `admin_role`            | Roles. `key` (predefined slug, unique), `isSystem`, `isSuperAdmin`.              |
| `admin_role_permission` | Matrix cell: one `(role, module) -> level`; unique `(roleId, resource)`. Sparse. |
| `admin_role_assignment` | Maps a userId to a roleId; unique `(userId, roleId)` (no dup assigns).           |
| `admin_invitation`      | Pending/accepted/revoked invite tokens                                           |

## Security invariants

- **Super-admin** = a role with `isSuperAdmin=true`. The resolver returns ALL grants for any user holding one. The bootstrap admin (`user.role='admin'`, no DB assignment) also counts as super-admin via the static fallback, so it is never locked out.
- **Admin-management routes require super-admin**: `createRole`, `updateRole`, `deleteRole`, `setRolePermissions`, `assignRole`, `unassignRole` throw `NotSuperAdminError` -> FORBIDDEN otherwise.
- **No privilege escalation**: `setRolePermissions` rejects granting a level above the caller's own effective level per module (super-admin caller passes). Throws `GrantEscalationError` -> FORBIDDEN.
- **Protected-role guards**: system (`isSystem`) roles cannot be DELETED, but predefined non-super roles MAY be renamed (and their permissions edited). The **super-admin role cannot be edited or deleted** at all (`updateRole`/`deleteRole`/`setRolePermissions` throw `ProtectedRoleError` -> CONFLICT - it is always full access). And you cannot unassign the final user holding any super-admin role (`LastSuperAdminError` -> CONFLICT); the count + delete run in one transaction with the holder rows locked `FOR UPDATE`, so concurrent unassigns cannot both strip the last super admin.
- The `admin` module (role/admin management) is NOT in the operator-editable catalog: it is omitted from `listCatalog` and a grant targeting it is rejected (`InvalidGrantError`). Admin capability comes ONLY from `isSuperAdmin`.
- Unknown module/level (or the non-assignable `admin` module) -> `InvalidGrantError` -> BAD_REQUEST.
- `assignRole` dedupes on the unique index (returns the existing row, no 500).
- `acceptInvitation` is a single atomic conditional UPDATE; a replay updates zero rows and emits no event.
- "Applies immediately to active sessions": `getGrants` resolves a user's grants in ONE indexed join (assignment -> role -> permission), then the resolver caches the result per user (`admin-grants:<userId>`) behind `CACHE` for a short 10s TTL. Revocation stays effectively immediate because the plugin purges the affected keys on `iam.role.assigned`/`iam.role.revoked` (user-keyed) and `iam.role.permissions.changed` (fanned out to every current holder via `invalidateRole`); the TTL is only the safety floor. When `CACHE` is unbound (eg some tests) the resolver just always hits the DB.

## Routes (`iam.*`)

| Procedure                         | Method | Path                              | Guard                                           |
| --------------------------------- | ------ | --------------------------------- | ----------------------------------------------- |
| `iam.listCatalog`                 | GET    | `/iam/catalog`                    | `admin:view`                                    |
| `iam.listRoles`                   | GET    | `/iam/roles`                      | `admin:view`                                    |
| `iam.getRole`                     | GET    | `/iam/roles/{roleId}`             | `admin:view`                                    |
| `iam.createRole`                  | POST   | `/iam/roles`                      | `admin:create` + super-admin                    |
| `iam.updateRole`                  | PATCH  | `/iam/roles/{roleId}`             | `admin:update` + super-admin                    |
| `iam.deleteRole`                  | DELETE | `/iam/roles/{roleId}`             | `admin:delete` + super-admin + protected-guard  |
| `iam.setRolePermissions`          | PUT    | `/iam/roles/{roleId}/permissions` | `admin:update` + super-admin + no-escalation    |
| `iam.assignRole`                  | POST   | `/iam/assignments`                | `admin:update` + super-admin (dedupes)          |
| `iam.unassignRole`                | DELETE | `/iam/assignments`                | `admin:update` + super-admin + last-super guard |
| `iam.listAssignments`             | GET    | `/iam/assignments`                | `admin:view`                                    |
| `iam.previewEffectivePermissions` | POST   | `/iam/effective-permissions`      | `admin:view`                                    |
| `iam.listInvitations`             | GET    | `/iam/invitations`                | `admin:view`                                    |
| `iam.inviteAdmin`                 | POST   | `/iam/invitations`                | `admin:create`                                  |
| `iam.acceptInvitation`            | POST   | `/iam/invitations/accept`         | none (public)                                   |

`previewEffectivePermissions` accepts EITHER `{ userId }` OR `{ roleIds }` and
returns the max level per module across those roles (a pure preview, no writes).

## Events emitted

| Topic                          | Payload                                  |
| ------------------------------ | ---------------------------------------- |
| `iam.invitation.accepted`      | `{ email, roleId, invitationId }`        |
| `iam.role.created`             | `{ roleId, name, actorId }`              |
| `iam.role.updated`             | `{ roleId, name?, actorId }`             |
| `iam.role.deleted`             | `{ roleId, actorId }`                    |
| `iam.role.permissions.changed` | `{ roleId, before[], after[], actorId }` |
| `iam.role.assigned`            | `{ roleId, userId, actorId }`            |
| `iam.role.revoked`             | `{ roleId, userId, actorId }`            |

Each `iam.role.*` payload carries an explicit `actorId` (the envelope does not).
The `audit` add-on subscribes to all six (`SUBSCRIBED_TOPICS`) and records them
with `actorType:'admin'`, `resourceType:'role'`, `resourceId:roleId`, carrying
`before`/`after`.

## Do

- Derive modules/levels from `statement` + `permission-levels.ts` (never hardcode).
- Treat `DEFAULT_ADMIN_ROLES` (`iam/seed/default-admin-roles.ts`) as the canonical spec: `seedRoles` is a convergent upsert keyed on `key`, so re-seeding reconciles names/levels back to the spec (it does not drop grants removed from it). Roles are seeded by a script, never a migration.

## Don't

- Import another module's root entry.
- Move user creation or money operations into this module.
- Write `no_access` rows (sparse storage); hardcode module/level strings.

## Done-when checklist

- [x] `pnpm regen` generated a migration in the module's `drizzle/migrations/`.
- [x] `pnpm verify` exits 0.
- [x] `ADMIN_PERMISSION_RESOLVER` bound in `plugin.ts`; super-admin bypass + level expansion.
- [x] Unit tests cover level helpers, resolver bypass/expansion, escalation + protected-role blocks, last-super-admin guard, assign-to-admin-only guard, preview union, `iam.role.*` emits.

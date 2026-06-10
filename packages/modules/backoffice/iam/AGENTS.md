# iam module

Identity & Access Management for the backoffice. Provides dynamic DB-backed RBAC
and admin onboarding via invitation tokens.

## What it does

Owns roles, permission grants, user-to-role assignments, and invitation tokens.
Binds `ADMIN_PERMISSION_RESOLVER` so `AdminGuard` authorizes against DB grants
instead of static roles when a user has an assignment row. Sends invitation emails
via the `SEND_EMAIL` port and emits `iam.invitation.accepted` after token acceptance.

## Layout (one folder under `packages/modules/backoffice/iam/src/`)

| Layer   | File                     | Holds                                                                            |
| ------- | ------------------------ | -------------------------------------------------------------------------------- |
| schema  | `schema/index.ts`        | Drizzle `pgTable`s + row types (`$inferSelect`). Every table carries `tenantId`. |
| schemas | `schemas/index.ts`       | re-exports from the contract slice; module-local Zod only                        |
| service | `service/iam.service.ts` | ALL business logic; emits events after DB commit                                 |
| router  | `router/index.ts`        | thin oRPC wiring: resolve caller, call service, `mapErrors`                      |
| plugin  | `plugin.ts`              | DI wiring only: `ctx.routers.add(...)`, `ctx.provide(...)`                       |

Contract slice: `packages/contracts/orpc-contract/src/iam.ts`.

## Extension points

| Point                        | How                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Override email sender        | `ctx.provide(SEND_EMAIL, ...)` in an overlay loaded after this module                                |
| React to accepted invitation | `ctx.events.on('iam.invitation.accepted', handler)` in an overlay                                    |
| Add permission resources     | Edit `packages/platform/auth/src/permissions.ts` `statement` - catalog and validation derive from it |

## Ports consumed

| Interface        | Token         | Purpose                        |
| ---------------- | ------------- | ------------------------------ |
| `SendEmailPort`  | `SEND_EMAIL`  | Deliver invitation emails      |
| `DrizzleService` | `DRIZZLE`     | All DB reads/writes            |
| `EventBus`       | `EVENT_BUS`   | Emit `iam.invitation.accepted` |
| `AdminGuard`     | `ADMIN_GUARD` | Guard every admin route        |

## Port provided

| Interface                 | Token                       | Impl                        |
| ------------------------- | --------------------------- | --------------------------- |
| `AdminPermissionResolver` | `ADMIN_PERMISSION_RESOLVER` | `DbAdminPermissionResolver` |

## Tables

| Table                   | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `admin_role`            | Named roles per tenant                                                 |
| `admin_role_permission` | Resource/action grants per role; carries `tenantId` so RLS isolates it |
| `admin_role_assignment` | Maps a userId to a roleId per tenant (no cross-module FK)              |
| `admin_invitation`      | Pending/accepted/revoked invite tokens                                 |

## Security invariants

- Tenant is resolved per request (`getCurrentTenantId()`) INSIDE every service/resolver method - never captured in a constructor (factories run once at boot outside the request ALS frame).
- No privilege escalation: `setRolePermissions` rejects any grant the caller does not already hold; `assignRole` rejects assigning a role whose grant set exceeds the caller's. The caller's effective grants are their DB assignment, or the static grants for `user.role` when they have none (bootstrap admin). Throws `GrantEscalationError` -> FORBIDDEN.
- Unknown (resource, action) -> `InvalidGrantError` -> BAD_REQUEST.
- `acceptInvitation` is a single atomic conditional UPDATE (`token + status='pending' + not expired`); a replay updates zero rows and emits no event (no double-provisioning).
- `admin` resource actions: `view, create, update, disable, delete` (see `permissions.ts`). `deleteRole` requires `admin:delete`.

## Routes (`iam.*`)

| Procedure                | Method | Path                              | Guard                                               |
| ------------------------ | ------ | --------------------------------- | --------------------------------------------------- |
| `iam.listCatalog`        | GET    | `/iam/catalog`                    | `admin:view`                                        |
| `iam.listRoles`          | GET    | `/iam/roles`                      | `admin:view`                                        |
| `iam.getRole`            | GET    | `/iam/roles/{roleId}`             | `admin:view`                                        |
| `iam.createRole`         | POST   | `/iam/roles`                      | `admin:create`                                      |
| `iam.updateRole`         | PATCH  | `/iam/roles/{roleId}`             | `admin:update`                                      |
| `iam.deleteRole`         | DELETE | `/iam/roles/{roleId}`             | `admin:delete`                                      |
| `iam.setRolePermissions` | PUT    | `/iam/roles/{roleId}/permissions` | `admin:update` + no-escalation (grant subset)       |
| `iam.assignRole`         | POST   | `/iam/assignments`                | `admin:update` + no-escalation (role grants subset) |
| `iam.listInvitations`    | GET    | `/iam/invitations`                | `admin:view`                                        |
| `iam.inviteAdmin`        | POST   | `/iam/invitations`                | `admin:create`                                      |
| `iam.acceptInvitation`   | POST   | `/iam/invitations/accept`         | none (public)                                       |

## Events emitted

| Topic                     | Payload                           | When                                                   |
| ------------------------- | --------------------------------- | ------------------------------------------------------ |
| `iam.invitation.accepted` | `{ email, roleId, invitationId }` | After token accepted; consumer provisions user account |

Note: the `userId` linkage to `admin_role_assignment` is completed by the consumer
of `iam.invitation.accepted` (typically an identity overlay), not by this module.

## Do

- Keep `tenantId` filters on every query.
- Derive resource/action lists from `statement` (never hardcode).
- Read identity `user` rows via `@oss/modules/platform/identity/schema` subpath if needed.

## Don't

- Import identity's service or any other module's root entry.
- Move user creation or money operations into this module.
- Hardcode resource/action strings - always derive from `statement`.

## Done-when checklist

- [ ] `pnpm regen` generated migration for the four tables.
- [ ] `pnpm verify --filter @oss/modules` exits 0.
- [ ] `list-routes module=iam` shows 11 routes.
- [ ] `list-modules` shows `iam` registered.
- [ ] `ADMIN_PERMISSION_RESOLVER` bound in `plugin.ts`.
- [ ] Unit tests cover: getGrants null, getGrants with grants, setRolePermissions invalid grant, inviteAdmin sends email.

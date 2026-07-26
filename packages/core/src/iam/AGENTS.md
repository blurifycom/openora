# iam

Identity & Access Management for the backoffice: dynamic DB-backed RBAC (a `(role x module) -> level` matrix), super-admin semantics, predefined roles seeded by script, admin onboarding via invitation tokens. Binds `ADMIN_PERMISSION_RESOLVER` so `AdminGuard` authorizes against DB grants: the resolver EXPANDS each stored `(module, level)` cell into the action grants the `AdminGuard.assert(ctx, resource, action)` call sites check - the guard and its call sites never change with the level model.

## Level model

Three totally ordered levels: `no_access` < `read` < `read_write`. Storage is sparse - only non-`no_access` cells exist; a missing module means `no_access`, deleting a row downgrades. Helpers live in `@openora/core/server` `permission-levels.ts` (`levelToActions`, `actionsToLevel`, `readActions`, `isLevelSufficient`) - always derive modules/levels from `statement` + these helpers, never hardcode strings. Gotchas: `content` has no `view` action, so `read` expands to `[]` (read-or-nothing); single-action modules (`report`, `analytics`) expand `read` and `read_write` identically.

## Security invariants

- Super-admin = a role with `isSuperAdmin=true`; the resolver returns ALL grants for its holders.
- Static-role fallback: for ANY user with NO assignment row, `AdminGuard` (`server/auth/admin-guard.ts`) falls back to the static better-auth role check - DB revocation is NOT authoritative while a static role still grants; revoke the static role to fully deny. This is how the bootstrap admin (`user.role='admin'`, no assignment row) counts as super-admin and can never be locked out.
- Role/permission/assignment mutations require super-admin (`NotSuperAdminError` -> FORBIDDEN).
- No escalation: `setRolePermissions` rejects granting a level above the caller's own effective level per module (`GrantEscalationError` -> FORBIDDEN; super-admin caller passes).
- Protected roles: `isSystem` roles cannot be DELETED, but predefined non-super roles MAY be renamed and re-permissioned. The super-admin role cannot be edited or deleted at all (`ProtectedRoleError` -> CONFLICT). The final user holding any super-admin role cannot be unassigned (`LastSuperAdminError` -> CONFLICT) - the count + delete run in one transaction with the holder rows locked `FOR UPDATE`, so concurrent unassigns cannot both strip the last super admin.
- The `admin` module (role/admin management) is NOT operator-editable: omitted from `listCatalog`, grants targeting it rejected (`InvalidGrantError` -> BAD_REQUEST). Admin capability comes ONLY from `isSuperAdmin`.
- `acceptInvitation` is one atomic conditional UPDATE - a replay updates zero rows and emits no event. `assignRole` dedupes on the unique index (returns the existing row, no 500).
- Grant freshness: `getGrants` resolves in one indexed join, cached per user (`admin-grants:<userId>`, 10s TTL) behind `CACHE`. Revocation stays effectively immediate because the plugin purges keys on `iam.role.assigned`/`revoked` (user-keyed) and `iam.role.permissions.changed` (fanned out to every current holder via `invalidateRole`); the TTL is only the safety floor. Unbound `CACHE` (some tests) = always hit the DB.

## Seeding

`DEFAULT_ADMIN_ROLES` (`seed/data/default-admin-roles.ts`) is the canonical spec; `seedRoles` is a convergent upsert keyed on `key` - re-seeding reconciles names/levels back to the spec but does not drop grants removed from it. Roles are seeded by script, never by migration.

## Extension points

- Override invitation email: `ctx.provide(SEND_EMAIL, ...)` in a later-loading overlay.
- React to onboarding: `ctx.events.on('iam.invitation.accepted', ...)`.
- Add permission modules: edit `statement` in `packages/core/src/server/auth/permissions.ts` - catalog, levels, and validation all derive from it.
- Each `iam.role.*` payload carries an explicit `actorId` (the envelope does not); the audit module subscribes to all of them.

## Don't

- Write `no_access` rows (sparse storage) or hardcode module/level strings.
- Move user creation or money operations into this module.

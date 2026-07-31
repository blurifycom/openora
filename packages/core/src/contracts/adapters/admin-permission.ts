// Port for DB-backed admin RBAC. A backoffice iam module binds a concrete
// resolver that reads role assignments + grants from its own tables; the
// AdminGuard (in @openora/core/server) depends only on this interface so the platform
// keeps working - falling back to the static roles - when no resolver is bound.
import { createToken, type Token } from './token.js';

export type AdminGrant = { resource: string; action: string };

export type AdminPermissionResolver = {
  // Returns the effective grants for an admin user, or null if the user has no
  // DB-backed role assignment (caller should fall back to static roles). May be
  // served from a cache - fine for the per-request authorization hot path.
  getGrants(userId: string): Promise<AdminGrant[] | null>;
  // Same contract as getGrants but bypasses any caching layer. Optional; callers
  // for whom a stale read is merely a hot-path perf trade-off (assert()) use
  // getGrants, but a caller re-verifying a claim against the CURRENT grant state
  // (e.g. AdminGuard.recordDeniedAccess, checking it isn't recording a denial for
  // a permission the caller was just given) must not be fooled by a not-yet-purged
  // cache entry and should call this instead. Falls back to getGrants when unset.
  getFreshGrants?(userId: string): Promise<AdminGrant[] | null>;
};

export const ADMIN_PERMISSION_RESOLVER: Token<AdminPermissionResolver> = createToken(
  'ADMIN_PERMISSION_RESOLVER',
);

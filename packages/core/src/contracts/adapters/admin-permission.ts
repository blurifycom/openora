// Port for DB-backed admin RBAC. A backoffice iam module binds a concrete
// resolver that reads role assignments + grants from its own tables; the
// AdminGuard (in @openora/core/server) depends only on this interface so the platform
// keeps working - falling back to the static roles - when no resolver is bound.
import { createToken, type Token } from './token.js';

export type AdminGrant = { resource: string; action: string };

export type AdminPermissionResolver = {
  // Returns the effective grants for an admin user, or null if the user has no
  // DB-backed role assignment (caller should fall back to static roles).
  getGrants(userId: string): Promise<AdminGrant[] | null>;
};

export const ADMIN_PERMISSION_RESOLVER: Token<AdminPermissionResolver> = createToken(
  'ADMIN_PERMISSION_RESOLVER',
);

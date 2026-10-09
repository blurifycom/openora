/**
 * Port for DB-backed admin RBAC. A backoffice iam module binds a concrete
 * resolver that reads role assignments + grants from its own tables; the
 * AdminGuard (in @openora/core/server) depends only on this interface. Once a
 * resolver is bound its answer is authoritative: an admin with no assigned role
 * holds no permissions. Only a deployment with no resolver bound at all falls
 * back to the static roles.
 */
import { createToken, type Token } from './token.js';

export type AdminGrant = { resource: string; action: string };

export type AdminPermissionResolver = {
  /** The admin's effective grants - empty when the user holds no assigned role. */
  getGrants(userId: string): Promise<AdminGrant[]>;
  /** Whether any assigned role is a super-admin role - false when none is assigned. */
  isSuperAdmin(userId: string): Promise<boolean>;
};

export const ADMIN_PERMISSION_RESOLVER: Token<AdminPermissionResolver> = createToken(
  'ADMIN_PERMISSION_RESOLVER',
);

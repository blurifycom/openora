import { SUPER_ADMIN_MANAGEMENT_LOCK_KEY } from '@openora/core/contracts';
import { type DrizzleTx } from '@openora/core/server';
import { and, eq, sql } from 'drizzle-orm';
// Read-only cross-domain schema import (sanctioned): only an account that can still sign in
// to the back office keeps admin management reachable.
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '../schema/index.js';

/**
 * Serialises every change that can end a super-admin's management access, for the rest of
 * `tx`. Take it BEFORE `McpTokenService.lockForRevocation`: the account-update path reaches
 * that table lock after this one, and the same order on every path cannot deadlock.
 */
export async function lockSuperAdminManagement(tx: DrizzleTx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SUPER_ADMIN_MANAGEMENT_LOCK_KEY}))`);
}

/** Super-admin role holdings whose account is active and still a back-office account. */
export function activeSuperAdminHoldings(tx: DrizzleTx) {
  return tx
    .select({ userId: adminRoleAssignment.userId, roleId: adminRoleAssignment.roleId })
    .from(adminRoleAssignment)
    .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
    .innerJoin(user, eq(user.id, adminRoleAssignment.userId))
    .where(and(eq(adminRole.isSuperAdmin, true), eq(user.isActive, true), eq(user.role, 'admin')));
}

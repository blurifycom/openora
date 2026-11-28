import { SUPER_ADMIN_MANAGEMENT_LOCK_KEY } from '@openora/core/contracts';
import { type DrizzleTx } from '@openora/core/server';
import { and, eq, sql } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '../schema/index.js';

export async function lockSuperAdminManagement(tx: DrizzleTx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SUPER_ADMIN_MANAGEMENT_LOCK_KEY}))`);
}

export function activeSuperAdminHoldings(tx: DrizzleTx) {
  return tx
    .select({ userId: adminRoleAssignment.userId, roleId: adminRoleAssignment.roleId })
    .from(adminRoleAssignment)
    .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
    .innerJoin(user, eq(user.id, adminRoleAssignment.userId))
    .where(and(eq(adminRole.isSuperAdmin, true), eq(user.isActive, true), eq(user.role, 'admin')));
}

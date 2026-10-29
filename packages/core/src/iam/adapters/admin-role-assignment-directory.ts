import type {
  AdminRoleAssignmentDirectory,
  AdminRoleAssignmentSummary,
} from '@openora/core/contracts';
import { DrizzleService, type DrizzleTx } from '@openora/core/server';
import { and, eq, inArray } from 'drizzle-orm';
import { adminRole, adminRoleAssignment } from '../schema/index.js';
import {
  activeSuperAdminHoldings,
  lockSuperAdminManagement,
} from '../shared/super-admin-retention.js';

export class DrizzleAdminRoleAssignmentDirectory implements AdminRoleAssignmentDirectory {
  constructor(private readonly drizzle: DrizzleService) {}

  async listByUserIds(userIds: readonly string[]): Promise<AdminRoleAssignmentSummary[]> {
    if (userIds.length === 0) {
      return [];
    }
    return this.drizzle.db
      .select({
        userId: adminRoleAssignment.userId,
        roleId: adminRoleAssignment.roleId,
        roleName: adminRole.name,
      })
      .from(adminRoleAssignment)
      .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
      .where(inArray(adminRoleAssignment.userId, userIds));
  }

  async keepsAnotherActiveSuperAdmin(userId: string, tx: unknown): Promise<boolean> {
    const txn = tx as DrizzleTx;
    await lockSuperAdminManagement(txn);
    // Read after the lock: under READ COMMITTED each statement sees every change committed
    // before it began, so a competing change that held the lock is already visible here.
    const [held] = await txn
      .select({ id: adminRoleAssignment.id })
      .from(adminRoleAssignment)
      .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
      .where(and(eq(adminRoleAssignment.userId, userId), eq(adminRole.isSuperAdmin, true)))
      .limit(1);
    if (!held) {
      return true;
    }
    const holdings = await activeSuperAdminHoldings(txn);
    return holdings.some((h) => h.userId !== userId);
  }
}

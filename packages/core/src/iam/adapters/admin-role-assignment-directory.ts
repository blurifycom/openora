import type {
  AdminRoleAssignmentDirectory,
  AdminRoleAssignmentSummary,
} from '@openora/core/contracts';
import { DrizzleService } from '@openora/core/server';
import { eq, inArray } from 'drizzle-orm';
import { adminRole, adminRoleAssignment } from '../schema/index.js';

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
}

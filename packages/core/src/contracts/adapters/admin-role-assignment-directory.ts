import { createToken, type Token } from './token.js';

export type AdminRoleAssignmentSummary = {
  userId: string;
  roleId: string;
  roleName: string;
};

/**
 * The one transaction-scoped advisory lock every change that can end a super-admin's
 * management access takes before it checks who is left: disabling or demoting an account,
 * and removing a super-admin role. A fixed key, not one per user - two super-admins
 * disabling each other touch two different rows, so only a shared lock serialises them.
 */
export const SUPER_ADMIN_MANAGEMENT_LOCK_KEY = 'iam:super-admin-management';

export type AdminRoleAssignmentDirectory = {
  /** Batch lookup; unknown/unassigned userIds are simply absent from the result. */
  listByUserIds(userIds: readonly string[]): Promise<AdminRoleAssignmentSummary[]>;
  /**
   * Inside the caller's transaction `tx`: takes `SUPER_ADMIN_MANAGEMENT_LOCK_KEY`, then answers
   * whether an active admin account other than `userId` still holds a super-admin role. True
   * when `userId` holds none, since losing them costs no management access. The lock is held
   * until `tx` ends, so the caller's write lands before any competing check reads.
   */
  keepsAnotherActiveSuperAdmin(userId: string, tx: unknown): Promise<boolean>;
};

export const ADMIN_ROLE_ASSIGNMENT_DIRECTORY: Token<AdminRoleAssignmentDirectory> = createToken(
  'ADMIN_ROLE_ASSIGNMENT_DIRECTORY',
);

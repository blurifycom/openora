import { createToken, type Token } from './token.js';

export type AdminRoleAssignmentSummary = {
  userId: string;
  roleId: string;
  roleName: string;
};

export const SUPER_ADMIN_MANAGEMENT_LOCK_KEY = 'iam:super-admin-management';

export type AdminRoleAssignmentDirectory = {
  listByUserIds(userIds: readonly string[]): Promise<AdminRoleAssignmentSummary[]>;
  keepsAnotherActiveSuperAdmin(userId: string, tx: unknown): Promise<boolean>;
};

export const ADMIN_ROLE_ASSIGNMENT_DIRECTORY: Token<AdminRoleAssignmentDirectory> = createToken(
  'ADMIN_ROLE_ASSIGNMENT_DIRECTORY',
);

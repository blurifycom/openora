import { createToken, type Token } from './token.js';

export type AdminRoleAssignmentSummary = {
  userId: string;
  roleId: string;
  roleName: string;
};

export type AdminRoleAssignmentDirectory = {
  /** Batch lookup; unknown/unassigned userIds are simply absent from the result. */
  listByUserIds(userIds: readonly string[]): Promise<AdminRoleAssignmentSummary[]>;
};

export const ADMIN_ROLE_ASSIGNMENT_DIRECTORY: Token<AdminRoleAssignmentDirectory> = createToken(
  'ADMIN_ROLE_ASSIGNMENT_DIRECTORY',
);

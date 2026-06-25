export {
  IamService,
  DbAdminPermissionResolver,
  RoleNotFoundError,
  InvitationNotFoundError,
  InvitationConflictError,
  InvalidGrantError,
  GrantEscalationError,
  NotSuperAdminError,
  ProtectedRoleError,
  LastSuperAdminError,
  AdminUserNotFoundError,
  NotAnAdminUserError,
} from './service/iam.service.js';
export { createIamRouter } from './router/index.js';
export type {
  AdminRole,
  AdminRoleWithGrants,
  AdminRoleAssignment,
  AdminRoleAssignmentDetail,
  AdminInvitation,
  Catalog,
  CatalogEntry,
  RolePermissionLevel,
  EffectivePermissions,
} from './schemas/index.js';
export { default } from './plugin.js';

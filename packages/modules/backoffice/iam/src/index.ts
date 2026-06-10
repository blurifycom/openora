// Public surface of the Iam module. Export only what other packages
// may consume; internal implementation details stay private. Cross-module table
// reads go through the `@oss/modules/backoffice/iam/schema` subpath.
export {
  IamService,
  DbAdminPermissionResolver,
  RoleNotFoundError,
  InvitationNotFoundError,
  InvitationConflictError,
} from './service/iam.service.js';
export { createIamRouter } from './router/index.js';
export type {
  AdminRole,
  AdminRoleWithGrants,
  AdminRoleAssignment,
  AdminInvitation,
  CatalogEntry,
} from './schemas/index.js';
export { default } from './plugin.js';

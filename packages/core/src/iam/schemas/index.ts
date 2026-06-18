export {
  iamContract,
  PermissionLevelSchema,
  AdminRoleSchema,
  RolePermissionLevelSchema,
  AdminRoleWithGrantsSchema,
  AdminRoleAssignmentSchema,
  AdminRoleAssignmentDetailSchema,
  AdminInvitationSchema,
  CatalogEntrySchema,
  CatalogSchema,
  GrantInputSchema,
  EffectivePermissionsSchema,
} from '../contract/index.js';
import type { z } from 'zod';
import type {
  AdminRoleSchema,
  AdminRoleWithGrantsSchema,
  AdminRoleAssignmentSchema,
  AdminRoleAssignmentDetailSchema,
  AdminInvitationSchema,
  CatalogEntrySchema,
  CatalogSchema,
  RolePermissionLevelSchema,
  EffectivePermissionsSchema,
} from '../contract/index.js';

export type AdminRole = z.infer<typeof AdminRoleSchema>;
export type AdminRoleWithGrants = z.infer<typeof AdminRoleWithGrantsSchema>;
export type AdminRoleAssignment = z.infer<typeof AdminRoleAssignmentSchema>;
export type AdminRoleAssignmentDetail = z.infer<typeof AdminRoleAssignmentDetailSchema>;
export type AdminInvitation = z.infer<typeof AdminInvitationSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type RolePermissionLevel = z.infer<typeof RolePermissionLevelSchema>;
export type EffectivePermissions = z.infer<typeof EffectivePermissionsSchema>;

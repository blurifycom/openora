export {
  iamContract,
  AdminRoleSchema,
  AdminRolePermissionSchema,
  AdminRoleWithGrantsSchema,
  AdminRoleAssignmentSchema,
  AdminInvitationSchema,
  CatalogEntrySchema,
  GrantInputSchema,
} from '@oss/orpc-contract/iam';
import type { z } from 'zod';
import type {
  AdminRoleSchema,
  AdminRoleWithGrantsSchema,
  AdminRoleAssignmentSchema,
  AdminInvitationSchema,
  CatalogEntrySchema,
} from '@oss/orpc-contract/iam';

export type AdminRole = z.infer<typeof AdminRoleSchema>;
export type AdminRoleWithGrants = z.infer<typeof AdminRoleWithGrantsSchema>;
export type AdminRoleAssignment = z.infer<typeof AdminRoleAssignmentSchema>;
export type AdminInvitation = z.infer<typeof AdminInvitationSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

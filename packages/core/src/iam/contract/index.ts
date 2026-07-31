import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  InvitationStatusSchema,
  PermissionLevelSchema,
  TimestampSchema,
  UuidSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';

export { InvitationStatusSchema, PermissionLevelSchema } from '@openora/core/contracts';

export const AdminRoleSchema = z.object({
  id: UuidSchema,
  // Stable slug for predefined roles (null for custom); the consumer maps it to
  // localized display copy. `name` is an English fallback / custom-role label.
  key: z.string().nullable(),
  name: z.string(),
  isSystem: z.boolean(),
  isSuperAdmin: z.boolean(),
  createdAt: TimestampSchema,
});

// A missing module entry means no_access; only non-no_access cells are stored.
export const RolePermissionLevelSchema = z.object({
  resource: z.string(),
  level: PermissionLevelSchema,
});

export const AdminRoleWithGrantsSchema = AdminRoleSchema.extend({
  permissions: z.array(RolePermissionLevelSchema),
});

export const AdminRoleAssignmentSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  roleId: UuidSchema,
  createdAt: TimestampSchema,
});

export const AdminRoleAssignmentDetailSchema = AdminRoleAssignmentSchema.extend({
  roleName: z.string(),
  roleKey: z.string().nullable(),
});

export const AdminInvitationSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  roleId: UuidSchema,
  token: z.string(),
  status: InvitationStatusSchema,
  expiresAt: TimestampSchema,
  acceptedAt: z.string().nullable(),
  createdAt: TimestampSchema,
});

export const CatalogEntrySchema = z.object({
  resource: z.string(),
  actions: z.array(z.string()),
  readActions: z.array(z.string()),
});

export const CatalogSchema = z.object({
  modules: z.array(CatalogEntrySchema),
  levels: z.array(PermissionLevelSchema),
});

export const GrantInputSchema = z.object({
  resource: z.string(),
  level: PermissionLevelSchema,
});

export const EffectivePermissionsSchema = z.object({
  permissions: z.array(RolePermissionLevelSchema),
});

export const ReportAccessDeniedSchema = z.object({
  recorded: z.boolean(),
});

export const IAM_ROLE_SORT_BY_VALUES = ['name', 'createdAt', 'key'] as const;
export const IamRoleSortBySchema = z.enum(IAM_ROLE_SORT_BY_VALUES).default('name');
export type IamRoleSortBy = z.infer<typeof IamRoleSortBySchema>;

export const IAM_ASSIGNMENT_SORT_BY_VALUES = ['createdAt'] as const;
export const IamAssignmentSortBySchema = z.enum(IAM_ASSIGNMENT_SORT_BY_VALUES).default('createdAt');
export type IamAssignmentSortBy = z.infer<typeof IamAssignmentSortBySchema>;

export const IAM_INVITATION_SORT_BY_VALUES = [
  'createdAt',
  'expiresAt',
  'email',
  'status',
  'acceptedAt',
] as const;
export const IamInvitationSortBySchema = z.enum(IAM_INVITATION_SORT_BY_VALUES).default('createdAt');
export type IamInvitationSortBy = z.infer<typeof IamInvitationSortBySchema>;

export const iamContract = {
  listCatalog: oc.route({ method: 'GET', path: '/iam/catalog' }).output(CatalogSchema),

  listRoles: oc
    .route({ method: 'GET', path: '/iam/roles' })
    .input(
      PageQuerySchema.extend({
        sortBy: IamRoleSortBySchema.optional(),
        sortOrder: SortOrderSchema.default('asc').optional(),
      }),
    )
    .output(paginated(AdminRoleWithGrantsSchema)),

  getRole: oc
    .route({ method: 'GET', path: '/iam/roles/{roleId}' })
    .input(z.object({ roleId: UuidSchema }))
    .output(AdminRoleWithGrantsSchema),

  createRole: oc
    .route({ method: 'POST', path: '/iam/roles' })
    .input(z.object({ name: z.string() }))
    .output(AdminRoleSchema),

  updateRole: oc
    .route({ method: 'PATCH', path: '/iam/roles/{roleId}' })
    .input(z.object({ roleId: UuidSchema, name: z.string().optional() }))
    .output(AdminRoleSchema),

  deleteRole: oc
    .route({ method: 'DELETE', path: '/iam/roles/{roleId}' })
    .input(z.object({ roleId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  setRolePermissions: oc
    .route({ method: 'PUT', path: '/iam/roles/{roleId}/permissions' })
    .input(
      z.object({
        roleId: UuidSchema,
        grants: z.array(GrantInputSchema),
      }),
    )
    .output(AdminRoleWithGrantsSchema),

  assignRole: oc
    .route({ method: 'POST', path: '/iam/assignments' })
    .input(z.object({ userId: UuidSchema, roleId: UuidSchema }))
    .output(AdminRoleAssignmentSchema),

  unassignRole: oc
    .route({ method: 'DELETE', path: '/iam/assignments' })
    .input(z.object({ userId: UuidSchema, roleId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  listAssignments: oc
    .route({ method: 'GET', path: '/iam/assignments' })
    .input(
      PageQuerySchema.extend({
        userId: UuidSchema.optional(),
        sortBy: IamAssignmentSortBySchema.optional(),
        sortOrder: SortOrderSchema.default('desc').optional(),
      }),
    )
    .output(paginated(AdminRoleAssignmentDetailSchema)),

  previewEffectivePermissions: oc
    .route({ method: 'POST', path: '/iam/effective-permissions' })
    .input(z.union([z.object({ userId: UuidSchema }), z.object({ roleIds: z.array(UuidSchema) })]))
    .output(EffectivePermissionsSchema),

  listInvitations: oc
    .route({ method: 'GET', path: '/iam/invitations' })
    .input(
      PageQuerySchema.extend({
        sortBy: IamInvitationSortBySchema.optional(),
        sortOrder: SortOrderSchema.default('desc').optional(),
      }),
    )
    .output(paginated(AdminInvitationSchema)),

  inviteAdmin: oc
    .route({ method: 'POST', path: '/iam/invitations' })
    .input(z.object({ email: z.email(), roleId: UuidSchema }))
    .output(AdminInvitationSchema),

  acceptInvitation: oc
    .route({ method: 'POST', path: '/iam/invitations/accept' })
    .input(z.object({ token: z.string() }))
    .output(z.object({ success: z.literal(true), email: z.string() })),

  forceLogout: oc
    .route({ method: 'POST', path: '/iam/assignments/force-logout' })
    .input(z.object({ userId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  getMyPermissions: oc
    .route({ method: 'GET', path: '/iam/my-permissions' })
    .output(EffectivePermissionsSchema),

  reportAccessDenied: oc
    .route({ method: 'POST', path: '/iam/access-denied' })
    .input(z.object({ resource: z.string(), level: PermissionLevelSchema }))
    .output(ReportAccessDeniedSchema),
};

export type AdminRole = z.infer<typeof AdminRoleSchema>;
export type AdminRoleWithGrants = z.infer<typeof AdminRoleWithGrantsSchema>;
export type AdminRoleAssignment = z.infer<typeof AdminRoleAssignmentSchema>;
export type AdminRoleAssignmentDetail = z.infer<typeof AdminRoleAssignmentDetailSchema>;
export type AdminInvitation = z.infer<typeof AdminInvitationSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type GrantInput = z.infer<typeof GrantInputSchema>;
export type RolePermissionLevel = z.infer<typeof RolePermissionLevelSchema>;
export type EffectivePermissions = z.infer<typeof EffectivePermissionsSchema>;
export type ReportAccessDenied = z.infer<typeof ReportAccessDeniedSchema>;

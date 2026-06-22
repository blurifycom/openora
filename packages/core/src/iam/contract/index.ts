import { oc } from '@orpc/contract';
import * as z from 'zod';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';

export const PermissionLevelSchema = z.enum(['no_access', 'read', 'read_write']);

export const AdminRoleSchema = z.object({
  id: z.uuid(),
  key: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  isSuperAdmin: z.boolean(),
  createdAt: z.iso.datetime(),
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
  id: z.uuid(),
  userId: z.uuid(),
  roleId: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const AdminRoleAssignmentDetailSchema = AdminRoleAssignmentSchema.extend({
  roleName: z.string(),
  roleKey: z.string().nullable(),
});

export const AdminInvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  roleId: z.uuid(),
  token: z.string(),
  status: z.enum(['pending', 'accepted', 'revoked']),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.iso.datetime(),
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

export const iamContract = {
  listCatalog: oc.route({ method: 'GET', path: '/iam/catalog' }).output(CatalogSchema),

  listRoles: oc
    .route({ method: 'GET', path: '/iam/roles' })
    .input(PageQuerySchema)
    .output(paginated(AdminRoleWithGrantsSchema)),

  getRole: oc
    .route({ method: 'GET', path: '/iam/roles/{roleId}' })
    .input(z.object({ roleId: z.uuid() }))
    .output(AdminRoleWithGrantsSchema),

  createRole: oc
    .route({ method: 'POST', path: '/iam/roles' })
    .input(z.object({ name: z.string(), description: z.string().optional() }))
    .output(AdminRoleSchema),

  updateRole: oc
    .route({ method: 'PATCH', path: '/iam/roles/{roleId}' })
    .input(
      z.object({
        roleId: z.uuid(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
      }),
    )
    .output(AdminRoleSchema),

  deleteRole: oc
    .route({ method: 'DELETE', path: '/iam/roles/{roleId}' })
    .input(z.object({ roleId: z.uuid() }))
    .output(z.object({ success: z.literal(true) })),

  setRolePermissions: oc
    .route({ method: 'PUT', path: '/iam/roles/{roleId}/permissions' })
    .input(
      z.object({
        roleId: z.uuid(),
        grants: z.array(GrantInputSchema),
      }),
    )
    .output(AdminRoleWithGrantsSchema),

  assignRole: oc
    .route({ method: 'POST', path: '/iam/assignments' })
    .input(z.object({ userId: z.uuid(), roleId: z.uuid() }))
    .output(AdminRoleAssignmentSchema),

  unassignRole: oc
    .route({ method: 'DELETE', path: '/iam/assignments' })
    .input(z.object({ userId: z.uuid(), roleId: z.uuid() }))
    .output(z.object({ success: z.literal(true) })),

  listAssignments: oc
    .route({ method: 'GET', path: '/iam/assignments' })
    .input(PageQuerySchema.extend({ userId: z.uuid().optional() }))
    .output(paginated(AdminRoleAssignmentDetailSchema)),

  previewEffectivePermissions: oc
    .route({ method: 'POST', path: '/iam/effective-permissions' })
    .input(z.union([z.object({ userId: z.uuid() }), z.object({ roleIds: z.array(z.uuid()) })]))
    .output(EffectivePermissionsSchema),

  listInvitations: oc
    .route({ method: 'GET', path: '/iam/invitations' })
    .input(PageQuerySchema)
    .output(paginated(AdminInvitationSchema)),

  inviteAdmin: oc
    .route({ method: 'POST', path: '/iam/invitations' })
    .input(z.object({ email: z.email(), roleId: z.uuid() }))
    .output(AdminInvitationSchema),

  acceptInvitation: oc
    .route({ method: 'POST', path: '/iam/invitations/accept' })
    .input(z.object({ token: z.string() }))
    .output(z.object({ success: z.literal(true), email: z.string() })),
};

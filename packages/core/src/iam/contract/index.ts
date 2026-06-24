import { oc } from '@orpc/contract';
import * as z from 'zod';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';
import { UuidSchema } from '@blurifycom/core/contracts';

export const PermissionLevelSchema = z.enum(['no_access', 'read', 'read_write']);

export const AdminRoleSchema = z.object({
  id: UuidSchema,
  // Stable slug for predefined roles (null for custom); the consumer maps it to
  // localized display copy. `name` is an English fallback / custom-role label.
  key: z.string().nullable(),
  name: z.string(),
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
  id: UuidSchema,
  userId: UuidSchema,
  roleId: UuidSchema,
  createdAt: z.iso.datetime(),
});

export const AdminRoleAssignmentDetailSchema = AdminRoleAssignmentSchema.extend({
  roleName: z.string(),
  roleKey: z.string().nullable(),
});

export const AdminInvitationSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  roleId: UuidSchema,
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
    .input(PageQuerySchema.extend({ userId: UuidSchema.optional() }))
    .output(paginated(AdminRoleAssignmentDetailSchema)),

  previewEffectivePermissions: oc
    .route({ method: 'POST', path: '/iam/effective-permissions' })
    .input(z.union([z.object({ userId: UuidSchema }), z.object({ roleIds: z.array(UuidSchema) })]))
    .output(EffectivePermissionsSchema),

  listInvitations: oc
    .route({ method: 'GET', path: '/iam/invitations' })
    .input(PageQuerySchema)
    .output(paginated(AdminInvitationSchema)),

  inviteAdmin: oc
    .route({ method: 'POST', path: '/iam/invitations' })
    .input(z.object({ email: z.email(), roleId: UuidSchema }))
    .output(AdminInvitationSchema),

  acceptInvitation: oc
    .route({ method: 'POST', path: '/iam/invitations/accept' })
    .input(z.object({ token: z.string() }))
    .output(z.object({ success: z.literal(true), email: z.string() })),
};

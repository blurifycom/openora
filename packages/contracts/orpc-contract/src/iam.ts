import { oc } from '@orpc/contract';
import * as z from 'zod';

// --- Shared output shapes ---

export const AdminRoleSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
});

export const AdminRolePermissionSchema = z.object({
  id: z.string(),
  roleId: z.string(),
  resource: z.string(),
  action: z.string(),
  createdAt: z.string(),
});

export const AdminRoleWithGrantsSchema = AdminRoleSchema.extend({
  permissions: z.array(AdminRolePermissionSchema),
});

export const AdminRoleAssignmentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  roleId: z.string(),
  createdAt: z.string(),
});

export const AdminInvitationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  email: z.string(),
  roleId: z.string(),
  token: z.string(),
  status: z.enum(['pending', 'accepted', 'revoked']),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const CatalogEntrySchema = z.object({
  resource: z.string(),
  actions: z.array(z.string()),
});

// --- Grant item used for setRolePermissions ---
export const GrantInputSchema = z.object({
  resource: z.string(),
  action: z.string(),
});

// --- Contract ---

export const iamContract = {
  listCatalog: oc
    .route({ method: 'GET', path: '/iam/catalog' })
    .output(z.array(CatalogEntrySchema)),

  listRoles: oc.route({ method: 'GET', path: '/iam/roles' }).output(z.array(AdminRoleSchema)),

  getRole: oc
    .route({ method: 'GET', path: '/iam/roles/{roleId}' })
    .input(z.object({ roleId: z.string() }))
    .output(AdminRoleWithGrantsSchema),

  createRole: oc
    .route({ method: 'POST', path: '/iam/roles' })
    .input(z.object({ name: z.string(), description: z.string().optional() }))
    .output(AdminRoleSchema),

  updateRole: oc
    .route({ method: 'PATCH', path: '/iam/roles/{roleId}' })
    .input(
      z.object({
        roleId: z.string(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
      }),
    )
    .output(AdminRoleSchema),

  deleteRole: oc
    .route({ method: 'DELETE', path: '/iam/roles/{roleId}' })
    .input(z.object({ roleId: z.string() }))
    .output(z.object({ success: z.literal(true) })),

  setRolePermissions: oc
    .route({ method: 'PUT', path: '/iam/roles/{roleId}/permissions' })
    .input(
      z.object({
        roleId: z.string(),
        grants: z.array(GrantInputSchema),
      }),
    )
    .output(AdminRoleWithGrantsSchema),

  assignRole: oc
    .route({ method: 'POST', path: '/iam/assignments' })
    .input(z.object({ userId: z.string(), roleId: z.string() }))
    .output(AdminRoleAssignmentSchema),

  listInvitations: oc
    .route({ method: 'GET', path: '/iam/invitations' })
    .output(z.array(AdminInvitationSchema)),

  inviteAdmin: oc
    .route({ method: 'POST', path: '/iam/invitations' })
    .input(z.object({ email: z.string().email(), roleId: z.string() }))
    .output(AdminInvitationSchema),

  acceptInvitation: oc
    .route({ method: 'POST', path: '/iam/invitations/accept' })
    .input(z.object({ token: z.string() }))
    .output(z.object({ success: z.literal(true), email: z.string() })),
};

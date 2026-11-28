import {
  ADMIN_PERMISSION_ROUTES,
  AdminPermissionWire,
  type AdminPermissionResolver,
} from '@openora/core/contracts';
import { internalProcedureFor } from '@openora/core/server';

export function createInternalAdminPermissionsRouter(
  resolver: AdminPermissionResolver,
  callers: ReadonlySet<string>,
) {
  const procedure = internalProcedureFor(callers, 'This service may not read admin permissions');
  return {
    adminGrants: procedure
      .route({ method: 'POST', path: ADMIN_PERMISSION_ROUTES.grants })
      .input(AdminPermissionWire.grants.input)
      .output(AdminPermissionWire.grants.output)
      .handler(async ({ input }) => ({ grants: await resolver.getGrants(input.userId) })),
    adminSuperAdmin: procedure
      .route({ method: 'POST', path: ADMIN_PERMISSION_ROUTES.superAdmin })
      .input(AdminPermissionWire.superAdmin.input)
      .output(AdminPermissionWire.superAdmin.output)
      .handler(async ({ input }) => ({ isSuperAdmin: await resolver.isSuperAdmin(input.userId) })),
  };
}

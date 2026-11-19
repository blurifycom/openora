import {
  ADMIN_PERMISSION_ROUTES,
  AdminPermissionWire,
  type AdminPermissionResolver,
} from '@openora/core/contracts';
import { internalProcedureFor } from '@openora/core/server';

/**
 * The internal API behind a remote `ADMIN_PERMISSION_RESOLVER`, for a service whose database has
 * no role assignments. It answers from the resolver iam binds here, so a grant cached on this
 * side is purged by the same events that purge it for local admin routes. Only the services
 * named in `callers` (`ADMIN_PERMISSION_CALLERS`, a comma list) may ask: a grant read is an
 * access decision. This guards against misconfiguration only: one install-wide secret signs as
 * any caller name.
 */
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

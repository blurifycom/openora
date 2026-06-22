import { implement } from '@orpc/server';
import { AdminGuard } from '@blurifycom/core/server';
import { mapErrors, type OssContext } from '@blurifycom/core/server';
import { iamContract } from '../contract/index.js';
import {
  IamService,
  RoleNotFoundError,
  InvitationNotFoundError,
  InvitationConflictError,
  InvalidGrantError,
  GrantEscalationError,
  NotSuperAdminError,
  ProtectedRoleError,
  LastSuperAdminError,
} from '../service/iam.service.js';

export function createIamRouter(svc: IamService, adminGuard: AdminGuard) {
  const os = implement(iamContract).$context<OssContext>();

  // Error map for the super-admin-only mutation routes. NotSuperAdminError and
  // GrantEscalationError -> FORBIDDEN; protected/last-super-admin -> CONFLICT.
  const adminMgmtErrors = {
    NOT_FOUND: RoleNotFoundError,
    BAD_REQUEST: InvalidGrantError,
    FORBIDDEN: [NotSuperAdminError, GrantEscalationError],
    CONFLICT: [ProtectedRoleError, LastSuperAdminError],
  };

  return os.router({
    listCatalog: os.listCatalog.handler(async ({ context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return svc.listCatalog();
    }),

    listRoles: os.listRoles.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return svc.listRoles(input);
    }),

    getRole: os.getRole.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return mapErrors({ NOT_FOUND: RoleNotFoundError }, () => svc.getRole(input.roleId));
    }),

    createRole: os.createRole.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'admin', 'create');
      return mapErrors(adminMgmtErrors, () => svc.createRole({ ...input, caller }));
    }),

    updateRole: os.updateRole.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'admin', 'update');
      return mapErrors(adminMgmtErrors, () =>
        svc.updateRole({
          roleId: input.roleId,
          name: input.name,
          description: input.description,
          caller,
        }),
      );
    }),

    deleteRole: os.deleteRole.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'admin', 'delete');
      return mapErrors(adminMgmtErrors, () => svc.deleteRole({ roleId: input.roleId, caller }));
    }),

    setRolePermissions: os.setRolePermissions.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'admin', 'update');
      return mapErrors(adminMgmtErrors, () => svc.setRolePermissions({ ...input, caller }));
    }),

    assignRole: os.assignRole.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'admin', 'update');
      return mapErrors(adminMgmtErrors, () => svc.assignRole({ ...input, caller }));
    }),

    unassignRole: os.unassignRole.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'admin', 'update');
      return mapErrors(adminMgmtErrors, () => svc.unassignRole({ ...input, caller }));
    }),

    listAssignments: os.listAssignments.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return svc.listAssignments(input);
    }),

    previewEffectivePermissions: os.previewEffectivePermissions.handler(
      async ({ input, context }) => {
        await adminGuard.assert(context, 'admin', 'view');
        return svc.previewEffectivePermissions(input);
      },
    ),

    listInvitations: os.listInvitations.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return svc.listInvitations(input);
    }),

    inviteAdmin: os.inviteAdmin.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'create');
      return mapErrors({ NOT_FOUND: RoleNotFoundError }, () => svc.inviteAdmin(input));
    }),

    // Public - invitee is not yet an admin.
    acceptInvitation: os.acceptInvitation.handler(({ input }) =>
      mapErrors({ NOT_FOUND: InvitationNotFoundError, CONFLICT: InvitationConflictError }, () =>
        svc.acceptInvitation(input.token),
      ),
    ),
  });
}

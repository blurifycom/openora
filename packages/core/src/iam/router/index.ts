import { implement } from '@orpc/server';
import { AdminGuard } from '@oss/core/server';
import { mapErrors, type OssContext } from '@oss/core/server';
import { iamContract } from '../contract/index.js';
import {
  IamService,
  RoleNotFoundError,
  InvitationNotFoundError,
  InvitationConflictError,
  InvalidGrantError,
  GrantEscalationError,
} from '../service/iam.service.js';

export function createIamRouter(svc: IamService, adminGuard: AdminGuard) {
  const os = implement(iamContract).$context<OssContext>();

  return os.router({
    listCatalog: os.listCatalog.handler(async ({ context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return svc.listCatalog();
    }),

    listRoles: os.listRoles.handler(async ({ context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return svc.listRoles();
    }),

    getRole: os.getRole.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return mapErrors({ NOT_FOUND: RoleNotFoundError }, () => svc.getRole(input.roleId));
    }),

    createRole: os.createRole.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'create');
      return svc.createRole(input);
    }),

    updateRole: os.updateRole.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'update');
      return mapErrors({ NOT_FOUND: RoleNotFoundError }, () =>
        svc.updateRole({ roleId: input.roleId, name: input.name, description: input.description }),
      );
    }),

    deleteRole: os.deleteRole.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'admin', 'delete');
      return mapErrors({ NOT_FOUND: RoleNotFoundError }, () => svc.deleteRole(input.roleId));
    }),

    setRolePermissions: os.setRolePermissions.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'admin', 'update');
      return mapErrors(
        {
          NOT_FOUND: RoleNotFoundError,
          BAD_REQUEST: InvalidGrantError,
          FORBIDDEN: GrantEscalationError,
        },
        () => svc.setRolePermissions({ ...input, caller }),
      );
    }),

    assignRole: os.assignRole.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'admin', 'update');
      return mapErrors({ NOT_FOUND: RoleNotFoundError, FORBIDDEN: GrantEscalationError }, () =>
        svc.assignRole({ ...input, caller }),
      );
    }),

    listInvitations: os.listInvitations.handler(async ({ context }) => {
      await adminGuard.assert(context, 'admin', 'view');
      return svc.listInvitations();
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

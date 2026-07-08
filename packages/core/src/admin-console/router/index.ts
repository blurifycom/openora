import { implement } from '@orpc/server';
import { AdminGuard, mapErrors, type OssContext } from '@openora/core/server';
import type { AuditWritePort } from '@openora/core/contracts';
import { backofficeContract } from '../contract/index.js';
import {
  BackofficeService,
  TransactionNotFoundError,
  UserNotFoundError,
} from '../service/backoffice.service.js';

export function createBackofficeRouter(
  backofficeService: BackofficeService,
  adminGuard: AdminGuard,
  audit: AuditWritePort,
) {
  const os = implement(backofficeContract).$context<OssContext>();

  return os.router({
    getStats: os.getStats.handler(async ({ context }) => {
      await adminGuard.assert(context, 'report', 'view');
      return backofficeService.getStats();
    }),

    listUsers: os.listUsers.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return backofficeService.listUsers(input.page, input.limit, input.search);
    }),

    getUser: os.getUser.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return mapErrors({ NOT_FOUND: UserNotFoundError }, () =>
        backofficeService.getUser(input.userId),
      );
    }),

    updateUser: os.updateUser.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'player', 'update');
      // Writing `user.role` (esp. 'admin') grants super-admin via the bootstrap path
      // (IamService.isSuperAdmin), so a role change is super-admin-only - the `admin`
      // resource is held only by super-admins.
      if (input.role !== undefined) {
        await adminGuard.assert(context, 'admin', 'update');
      }
      const before = await mapErrors({ NOT_FOUND: UserNotFoundError }, () =>
        backofficeService.getUser(input.userId),
      );
      const updated = await mapErrors({ NOT_FOUND: UserNotFoundError }, () =>
        backofficeService.updateUser(
          input.userId,
          { isActive: input.isActive, role: input.role },
          caller.userId,
        ),
      );
      await audit.record({
        actorId: caller.userId,
        actorType: 'admin',
        action: 'admin.user.updated',
        resourceType: 'user',
        resourceId: input.userId,
        before: { isActive: before.isActive, role: before.role },
        after: { isActive: updated.isActive, role: updated.role },
      });
      return updated;
    }),

    listTransactions: os.listTransactions.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'transaction', 'view');
      return backofficeService.listTransactions(input);
    }),

    getTransaction: os.getTransaction.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'transaction', 'view');
      return mapErrors({ NOT_FOUND: TransactionNotFoundError }, () =>
        backofficeService.getTransaction(input.id),
      );
    }),
  });
}

import { implement } from '@orpc/server';
import { AdminGuard } from '@blurifycom/core/server';
import { mapErrors, type OssContext } from '@blurifycom/core/server';
import { backofficeContract } from '../contract/index.js';
import { BackofficeService, UserNotFoundError } from '../service/backoffice.service.js';

export function createBackofficeRouter(
  backofficeService: BackofficeService,
  adminGuard: AdminGuard,
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
      await adminGuard.assert(context, 'player', 'update');
      return mapErrors({ NOT_FOUND: UserNotFoundError }, () =>
        backofficeService.updateUser(input.userId, { isActive: input.isActive, role: input.role }),
      );
    }),

    listTransactions: os.listTransactions.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'transaction', 'view');
      return backofficeService.listTransactions(input.page, input.limit, input.userId);
    }),
  });
}

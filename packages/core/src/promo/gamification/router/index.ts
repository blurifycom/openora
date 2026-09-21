import { implement } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { gamificationContract } from '../contract/index.js';
import {
  RankAdminService,
  RankLadderInvalidError,
  RankLadderMismatchError,
} from '../service/rank-admin.service.js';
import { RankLadderNotConfiguredError, RankService } from '../service/rank.service.js';

export function createGamificationRouter({
  ranks,
  admin,
  adminGuard,
}: {
  ranks: RankService;
  admin: RankAdminService;
  adminGuard: AdminGuard;
}) {
  const os = implement(gamificationContract).$context<OssContext>();

  return os.router({
    ranks: {
      get: os.ranks.get.handler(({ context }) =>
        mapErrors({ NOT_FOUND: RankLadderNotConfiguredError }, () =>
          ranks.getForPlayer(getUserId(context)),
        ),
      ),
    },

    admin: {
      ranks: {
        get: os.admin.ranks.get.handler(async ({ context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return mapErrors({ NOT_FOUND: RankLadderNotConfiguredError }, () => admin.get());
        }),

        set: os.admin.ranks.set.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'update');
          return mapErrors(
            {
              BAD_REQUEST: [RankLadderMismatchError, RankLadderInvalidError],
              NOT_FOUND: RankLadderNotConfiguredError,
            },
            () => admin.set(userId, input),
          );
        }),
      },
    },
  });
}

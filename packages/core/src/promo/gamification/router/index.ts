import { implement } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { gamificationContract } from '../contract/index.js';
import {
  RankAdminService,
  RankConfigInvalidError,
  RankConfigNotSetError,
  RankLadderCurrencyHeldError,
  RankLadderInvalidError,
  RankLadderMismatchError,
  RankTierHeldError,
  RankTierKeyTakenError,
} from '../service/rank-admin.service.js';
import { RankLadderNotConfiguredError, RankService } from '../service/rank.service.js';
import { StreakAdminService } from '../service/streak-admin.service.js';
import { StreakConfigNotSetError, StreakService } from '../service/streak.service.js';

export function createGamificationRouter({
  ranks,
  admin,
  streaks,
  streakAdmin,
  adminGuard,
}: {
  ranks: RankService;
  admin: RankAdminService;
  streaks: StreakService;
  streakAdmin: StreakAdminService;
  adminGuard: AdminGuard;
}) {
  const os = implement(gamificationContract).$context<OssContext>();

  return os.router({
    ranks: {
      // No `getUserId`: this one is public, and must stay that way.
      ladder: os.ranks.ladder.handler(() =>
        mapErrors({ NOT_FOUND: RankLadderNotConfiguredError }, () => ranks.getLadder()),
      ),

      get: os.ranks.get.handler(({ context }) =>
        mapErrors({ NOT_FOUND: RankLadderNotConfiguredError }, () =>
          ranks.getForPlayer(getUserId(context)),
        ),
      ),

      // No `getUserId`: public, so a chat avatar can show another player's rank badge.
      lookup: os.ranks.lookup.handler(({ input }) => ranks.lookup([...new Set(input.userIds)])),
    },

    streaks: {
      get: os.streaks.get.handler(({ context }) =>
        mapErrors({ NOT_FOUND: StreakConfigNotSetError }, () =>
          streaks.getForPlayer(getUserId(context)),
        ),
      ),

      leaderboard: os.streaks.leaderboard.handler(({ context }) =>
        streaks.leaderboard(getUserId(context)),
      ),
    },

    admin: {
      streaks: {
        config: {
          get: os.admin.streaks.config.get.handler(async ({ context }) => {
            await adminGuard.assert(context, 'bonus', 'view');
            return mapErrors({ NOT_FOUND: StreakConfigNotSetError }, () => streakAdmin.getConfig());
          }),

          set: os.admin.streaks.config.set.handler(async ({ input, context }) => {
            const { userId } = await adminGuard.assert(context, 'bonus', 'update');
            return streakAdmin.setConfig(userId, input);
          }),
        },
      },

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
              CONFLICT: [RankTierHeldError, RankLadderCurrencyHeldError, RankTierKeyTakenError],
              NOT_FOUND: RankLadderNotConfiguredError,
            },
            () => admin.set(userId, input),
          );
        }),

        config: {
          get: os.admin.ranks.config.get.handler(async ({ context }) => {
            await adminGuard.assert(context, 'bonus', 'view');
            return mapErrors({ NOT_FOUND: RankConfigNotSetError }, () => admin.getConfig());
          }),

          set: os.admin.ranks.config.set.handler(async ({ input, context }) => {
            const { userId } = await adminGuard.assert(context, 'bonus', 'update');
            return mapErrors({ BAD_REQUEST: RankConfigInvalidError }, () =>
              admin.setConfig(userId, input),
            );
          }),
        },
      },
    },
  });
}

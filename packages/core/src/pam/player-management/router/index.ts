import { implement } from '@orpc/server';
import { AdminGuard } from '@blurifycom/core/server';
import { mapErrors, type OssContext } from '@blurifycom/core/server';
import { playerContract } from '../contract/index.js';
import { PlayerService, PlayerNotFoundError } from '../service/player.service.js';

export function createPlayerRouter(player: PlayerService, adminGuard: AdminGuard) {
  const os = implement(playerContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return player.list(input.page, input.limit, input.search, input.status);
    }),

    get: os.get.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () => player.get(input.playerId));
    }),

    update: os.update.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'update');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () =>
        player.update(input.playerId, {
          displayName: input.displayName,
          status: input.status,
          kycStatus: input.kycStatus,
          level: input.level,
        }),
      );
    }),

    remove: os.remove.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'ban');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () => player.remove(input.playerId));
    }),

    registrationsOverTime: os.registrationsOverTime.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'analytics', 'view');
      return player.registrationsOverTime(input.days ?? 30);
    }),

    summary: os.summary.handler(async ({ context }) => {
      await adminGuard.assert(context, 'analytics', 'view');
      return player.summary();
    }),
  });
}

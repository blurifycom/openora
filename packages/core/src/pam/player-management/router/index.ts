import { implement } from '@orpc/server';
import { AdminGuard, mapErrors, type OssContext } from '@blurifycom/core/server';
import { playerContract } from '../contract/index.js';
import { PlayerService, PlayerNotFoundError } from '../service/player.service.js';

export function createPlayerRouter(player: PlayerService, adminGuard: AdminGuard) {
  const os = implement(playerContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return player.list(input);
    }),

    get: os.get.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'player', 'view');
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () => player.get(input.playerId));
    }),

    update: os.update.handler(async ({ input, context }) => {
      const { userId: actorId } = await adminGuard.assert(context, 'player', 'update');
      // A KYC-status transition is a regulated compliance action (bypassing it via
      // player:update would sidestep the sealed KYC_STATUS_WRITER invariant), so it
      // requires the compliance override permission in addition to player:update.
      if (input.kycStatus !== undefined) {
        await adminGuard.assert(context, 'compliance', 'override-limit');
      }
      return mapErrors({ NOT_FOUND: PlayerNotFoundError }, () =>
        player.update(
          input.playerId,
          {
            displayName: input.displayName,
            status: input.status,
            kycStatus: input.kycStatus,
            level: input.level,
          },
          actorId,
        ),
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

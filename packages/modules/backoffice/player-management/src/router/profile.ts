import { implement } from '@orpc/server';
import { getUserId, type OssContext } from '@oss/core';
import { contract } from '@oss/orpc-contract';
import { PlayerService } from '../service/player.service.js';

// Player-facing self-profile router. Caller resolved from x-user-id (via
// getUserId); never admin-guarded. The admin PAM surface is createPlayerRouter.
export function createProfileRouter(player: PlayerService) {
  const os = implement(contract.profile).$context<OssContext>();

  return os.router({
    get: os.get.handler(({ context }) => player.getMyProfile(getUserId(context))),

    update: os.update.handler(({ input, context }) =>
      player.updateMyProfile(getUserId(context), input),
    ),
  });
}

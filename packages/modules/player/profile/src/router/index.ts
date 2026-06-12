import { implement } from '@orpc/server';
import { getUserId, type OssContext } from '@oss/core';
import { contract } from '@oss/orpc-contract';
import { ProfileService } from '../service/profile.service.js';

// Player-facing self-profile router. Caller resolved from the verified session
// (via getUserId); never admin-guarded. The admin PAM surface is the add-on
// @oss-addons/player-management package.
export function createProfileRouter(profile: ProfileService) {
  const os = implement(contract.profile).$context<OssContext>();

  return os.router({
    get: os.get.handler(({ context }) => profile.getMyProfile(getUserId(context))),

    update: os.update.handler(({ input, context }) =>
      profile.updateMyProfile(getUserId(context), input),
    ),
  });
}

import { implement } from '@orpc/server';
import { getUserId, type OssContext } from '@openora/core/server';
import { profileContract } from '../contract/index.js';
import { ProfileService } from '../service/profile.service.js';

export function createProfileRouter(profile: ProfileService) {
  const os = implement(profileContract).$context<OssContext>();

  return os.router({
    get: os.get.handler(({ context }) => profile.getMyProfile(getUserId(context))),

    update: os.update.handler(({ input, context }) =>
      profile.updateMyProfile(getUserId(context), input),
    ),
  });
}

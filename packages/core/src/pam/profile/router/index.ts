import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@blurifycom/core/server';
import { profileContract } from '../contract/index.js';
import { ProfileService, UnsopportedLanguageError } from '../service/profile.service.js';

export function createProfileRouter(profile: ProfileService) {
  const os = implement(profileContract).$context<OssContext>();

  return os.router({
    get: os.get.handler(({ context }) => profile.getMyProfile(getUserId(context))),

    update: os.update.handler(({ input, context }) =>
      mapErrors({ BAD_REQUEST: UnsopportedLanguageError }, () =>
        profile.updateMyProfile(getUserId(context), input),
      ),
    ),
  });
}

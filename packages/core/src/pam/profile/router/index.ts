import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@openora/core/server';
import { profileContract } from '../contract/index.js';
import { ProfileService, UnsupportedDisplayCurrencyError } from '../service/profile.service.js';

export function createProfileRouter(profile: ProfileService) {
  const os = implement(profileContract).$context<OssContext>();

  return os.router({
    get: os.get.handler(({ context }) => profile.getMyProfile(getUserId(context))),

    update: os.update.handler(({ input, context }) =>
      profile.updateMyProfile(getUserId(context), input),
    ),

    getDisplayCurrency: os.getDisplayCurrency.handler(({ context }) =>
      profile.getMyDisplayCurrency(getUserId(context)),
    ),

    setDisplayCurrency: os.setDisplayCurrency.handler(({ input, context }) =>
      mapErrors({ BAD_REQUEST: UnsupportedDisplayCurrencyError }, () =>
        profile.setMyDisplayCurrency(getUserId(context), input),
      ),
    ),
  });
}

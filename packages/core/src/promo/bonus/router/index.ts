import { implement } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { bonusContract } from '../contract/index.js';
import { GrantNotFoundError, GrantReaderService } from '../service/grant-reader.service.js';
import {
  OfferClaimedError,
  OfferKeyTakenError,
  OfferNotEligibleError,
  OfferNotFoundError,
  OfferService,
} from '../service/offer.service.js';

export function createBonusRouter({
  grants,
  offers,
  adminGuard,
}: {
  grants: GrantReaderService;
  offers: OfferService;
  adminGuard: AdminGuard;
}) {
  const os = implement(bonusContract).$context<OssContext>();

  return os.router({
    offers: {
      list: os.offers.list.handler(({ context }) => offers.listForPlayer(getUserId(context))),

      optIn: os.offers.optIn.handler(({ input, context }) =>
        mapErrors({ NOT_FOUND: OfferNotFoundError, CONFLICT: OfferNotEligibleError }, () =>
          offers.optIn(getUserId(context), input.id),
        ),
      ),
    },

    admin: {
      offers: {
        list: os.admin.offers.list.handler(async ({ input, context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return offers.listForAdmin(input);
        }),

        create: os.admin.offers.create.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'create');
          return mapErrors({ CONFLICT: OfferKeyTakenError }, () => offers.create(userId, input));
        }),

        update: os.admin.offers.update.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'update');
          return mapErrors({ NOT_FOUND: OfferNotFoundError, CONFLICT: OfferClaimedError }, () =>
            offers.update(userId, input),
          );
        }),
      },
    },

    grants: {
      list: os.grants.list.handler(({ input, context }) => grants.list(getUserId(context), input)),

      get: os.grants.get.handler(({ input, context }) =>
        mapErrors({ NOT_FOUND: GrantNotFoundError }, () =>
          grants.get(getUserId(context), input.id),
        ),
      ),
    },
  });
}

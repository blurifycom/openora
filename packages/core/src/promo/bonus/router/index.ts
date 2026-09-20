import { implement } from '@orpc/server';
import {
  getUserId,
  mapErrors,
  type AdminGuard,
  type EventBus,
  type OssContext,
} from '@openora/core/server';
import { bonusContract } from '../contract/index.js';
import {
  GrantLifecycleService,
  GrantNotForfeitableError,
  GrantNotFoundError as GrantNotForfeitableNotFoundError,
} from '../service/grant-lifecycle.service.js';
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
  lifecycle,
  events,
  adminGuard,
}: {
  grants: GrantReaderService;
  offers: OfferService;
  lifecycle: GrantLifecycleService;
  events: EventBus;
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
      grants: {
        list: os.admin.grants.list.handler(async ({ input, context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return grants.listForAdmin(input.userId, input);
        }),

        forfeit: os.admin.grants.forfeit.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'cancel');
          return mapErrors(
            { CONFLICT: GrantNotForfeitableError, NOT_FOUND: GrantNotForfeitableNotFoundError },
            async () => {
              const closed = await lifecycle.forfeit(
                input.id,
                'admin',
                { id: userId, isAdmin: true },
                input.note,
              );
              events.emit('promo.bonus.forfeited', {
                userId: closed.userId,
                grantId: closed.grantId,
                currency: closed.currency,
                forfeitedAmount: closed.forfeitedAmount,
                reason: 'admin',
                actorId: closed.actorId,
              });
              return grants.getForAdmin(input.id);
            },
          );
        }),
      },

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

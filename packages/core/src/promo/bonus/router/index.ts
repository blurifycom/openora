import { implement } from '@orpc/server';
import {
  createEventStreamGenerator,
  getUserId,
  mapErrors,
  type AdminGuard,
  type EventBus,
  type OssContext,
} from '@openora/core/server';
import type { RealtimeTransport, Uuid } from '@openora/core/contracts';
import { bonusContract, type BonusBalanceUpdate } from '../contract/index.js';

/** One channel per player: a bonus position is never another player's business. */
export function bonusBalanceChannel(userId: Uuid): string {
  return `promo:balance:${userId}`;
}
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
import {
  WagerWeightProfileNameTakenError,
  WeightProfileNotFoundError,
  WeightService,
} from '../service/weight.service.js';

export function createBonusRouter({
  grants,
  offers,
  weights,
  lifecycle,
  events,
  realtime,
  adminGuard,
}: {
  grants: GrantReaderService;
  offers: OfferService;
  weights: WeightService;
  lifecycle: GrantLifecycleService;
  events: EventBus;
  realtime: RealtimeTransport;
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
            {
              CONFLICT: GrantNotForfeitableError,
              // The lifecycle service's not-found (the forfeit target itself) and the reader's
              // (the post-commit read-back) are separate classes built from separate
              // `makeNotFoundError('Grant')` calls, so both need naming here or the read-back's
              // 404 falls through unmapped to a 500.
              NOT_FOUND: [GrantNotForfeitableNotFoundError, GrantNotFoundError],
            },
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

      weights: {
        list: os.admin.weights.list.handler(async ({ context }) => {
          await adminGuard.assert(context, 'bonus', 'view');
          return weights.list();
        }),

        create: os.admin.weights.create.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'create');
          return mapErrors({ CONFLICT: WagerWeightProfileNameTakenError }, () =>
            weights.create(userId, input),
          );
        }),

        set: os.admin.weights.set.handler(async ({ input, context }) => {
          const { userId } = await adminGuard.assert(context, 'bonus', 'update');
          return mapErrors({ NOT_FOUND: WeightProfileNotFoundError }, () =>
            weights.set(userId, input),
          );
        }),
      },
    },

    balance: {
      get: os.balance.get.handler(({ input, context }) =>
        grants.balances(getUserId(context), input.currency),
      ),

      stream: os.balance.stream.handler(({ context, signal }) =>
        createEventStreamGenerator(
          (push) =>
            realtime.subscribe<BonusBalanceUpdate>(bonusBalanceChannel(getUserId(context)), push),
          { signal },
        ),
      ),
    },

    grants: {
      list: os.grants.list.handler(({ input, context }) => grants.list(getUserId(context), input)),

      get: os.grants.get.handler(({ input, context }) =>
        mapErrors({ NOT_FOUND: GrantNotFoundError }, () =>
          grants.get(getUserId(context), input.id),
        ),
      ),

      entries: os.grants.entries.handler(({ input, context }) =>
        mapErrors({ NOT_FOUND: GrantNotFoundError }, () =>
          grants.entries(getUserId(context), input.id, input),
        ),
      ),
    },
  });
}

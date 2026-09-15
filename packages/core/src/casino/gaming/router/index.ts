import { implement } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { gamingContract, gamingAdminContract } from '../contract/index.js';
import {
  GamingService,
  GameNotFoundError,
  GameRoundNotFoundError,
  GameSlugTakenError,
  GameAggregatorNotMappedError,
  RgRestrictedError,
  InsufficientBalanceError,
  GameGeoRestrictedError,
} from '../service/gaming.service.js';
import {
  GameCategoryService,
  GameCategoryNotFoundError,
  GameCategorySlugTakenError,
} from '../service/game-category.service.js';
import {
  GameTagService,
  GameTagNameTakenError,
  GameTagNotFoundError,
  GameTagSystemDeletionError,
} from '../service/game-tag.service.js';
import {
  GameProviderService,
  GameProviderNotFoundError,
  GameProviderSlugTakenError,
  GameProviderVendorIdTakenError,
  GameProviderMappingInUseError,
} from '../service/game-provider.service.js';
import { RgLimitExceededError } from '@openora/core/contracts';

export function createGamingRouter({
  gaming,
  providers,
  categories,
  tags,
  adminGuard,
}: {
  gaming: GamingService;
  providers: GameProviderService;
  categories: GameCategoryService;
  tags: GameTagService;
  adminGuard: AdminGuard;
}) {
  const os = implement({ ...gamingContract, ...gamingAdminContract }).$context<OssContext>();

  return os.router({
    listGames: os.listGames.handler(({ input }) => gaming.listGamesPublic(input)),

    getGame: os.getGame.handler(({ input }) =>
      mapErrors({ NOT_FOUND: GameNotFoundError }, () =>
        gaming.getGame(input.id, { activeOnly: true }),
      ),
    ),

    startRound: os.startRound.handler(({ input, context }) =>
      mapErrors(
        {
          NOT_FOUND: GameNotFoundError,
          CONFLICT: [RgRestrictedError, RgLimitExceededError, GameGeoRestrictedError],
          BAD_REQUEST: InsufficientBalanceError,
        },
        () =>
          gaming.startRound(
            getUserId(context),
            input.gameId,
            input.currency,
            input.betAmount,
            context.clientMeta.ip,
          ),
      ),
    ),

    endRound: os.endRound.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: GameRoundNotFoundError }, () =>
        gaming.endRound(getUserId(context), input.roundId),
      ),
    ),

    listRounds: os.listRounds.handler(({ context }) => gaming.getUserRounds(getUserId(context))),

    listProviders: os.listProviders.handler(({ input }) => providers.listActiveProviders(input)),

    getProviderBySlug: os.getProviderBySlug.handler(({ input }) =>
      mapErrors({ NOT_FOUND: GameProviderNotFoundError }, () =>
        providers.getActiveProviderBySlug(input.slug),
      ),
    ),

    listCategories: os.listCategories.handler(({ input }) =>
      categories.listActiveCategories(input),
    ),

    getCategoryBySlug: os.getCategoryBySlug.handler(({ input }) =>
      mapErrors({ NOT_FOUND: GameCategoryNotFoundError }, () =>
        categories.getActiveCategoryBySlug(input.slug),
      ),
    ),

    listAdminProviders: os.listAdminProviders.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return providers.listProvidersAdmin(input);
    }),

    getAdminProvider: os.getAdminProvider.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return mapErrors({ NOT_FOUND: GameProviderNotFoundError }, () =>
        providers.getProvider(input.id),
      );
    }),

    createProvider: os.createProvider.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'create');
      return mapErrors(
        { CONFLICT: [GameProviderSlugTakenError, GameProviderVendorIdTakenError] },
        () => providers.createProvider({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    updateProvider: os.updateProvider.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        {
          NOT_FOUND: GameProviderNotFoundError,
          CONFLICT: [
            GameProviderSlugTakenError,
            GameProviderVendorIdTakenError,
            GameProviderMappingInUseError,
          ],
        },
        () => providers.updateProvider({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    listAdminCategories: os.listAdminCategories.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return categories.listCategoriesAdmin(input);
    }),

    getAdminCategory: os.getAdminCategory.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return mapErrors({ NOT_FOUND: GameCategoryNotFoundError }, () =>
        categories.getCategory(input.id),
      );
    }),

    createCategory: os.createCategory.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'create');
      return mapErrors({ CONFLICT: GameCategorySlugTakenError }, () =>
        categories.createCategory({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    updateCategory: os.updateCategory.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        { NOT_FOUND: GameCategoryNotFoundError, CONFLICT: GameCategorySlugTakenError },
        () => categories.updateCategory({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    listAdminTags: os.listAdminTags.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return tags.listTagsAdmin(input);
    }),

    getAdminTag: os.getAdminTag.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return mapErrors({ NOT_FOUND: GameTagNotFoundError }, () => tags.getTag(input.id));
    }),

    createTag: os.createTag.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'create');
      return mapErrors({ CONFLICT: GameTagNameTakenError }, () =>
        tags.createTag({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    updateTag: os.updateTag.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        {
          NOT_FOUND: GameTagNotFoundError,
          CONFLICT: GameTagNameTakenError,
        },
        () => tags.updateTag({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    deleteTag: os.deleteTag.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'delete');
      return mapErrors(
        { NOT_FOUND: GameTagNotFoundError, CONFLICT: GameTagSystemDeletionError },
        () => tags.deleteTag({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    updateGame: os.updateGame.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        {
          NOT_FOUND: [
            GameNotFoundError,
            GameProviderNotFoundError,
            GameCategoryNotFoundError,
            GameTagNotFoundError,
          ],
          CONFLICT: [GameSlugTakenError, GameAggregatorNotMappedError],
        },
        () => gaming.updateGame({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    listAdminGames: os.listAdminGames.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return gaming.listGamesAdmin(input);
    }),

    getCatalogStats: os.getCatalogStats.handler(async ({ context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return gaming.getCatalogStats();
    }),
  });
}

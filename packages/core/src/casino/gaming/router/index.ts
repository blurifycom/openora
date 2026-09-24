import { implement } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { GameSortService, GameSortConfigInvalidError } from '../service/game-sort.service.js';
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
  GameGeoFiltersUnavailableError,
} from '../service/gaming.service.js';
import {
  GameCategoryService,
  GameCategoryNotFoundError,
  GameCategorySlugTakenError,
  GameCategoryRuleRequiredError,
  GameCategoryUpdateContendedError,
  CategoryGameNotMemberError,
} from '../service/game-category.service.js';
import {
  GameCategoryMembershipService,
  GameCategoryMembershipContendedError,
  GameCategoryNotRuleManagedError,
  GameCategoryRuleManagedError,
} from '../service/game-category-membership.service.js';
import {
  GameCategoryRuleService,
  GameCategoryRuleInvalidError,
  GameCategoryRuleTooBroadError,
  GameCategoryRuleUnavailableError,
  type GameCategoryRuleAuthorizer,
} from '../service/game-category-rule.service.js';
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
import { GameBulkService, GameBulkTooManyGamesError } from '../service/game-bulk.service.js';
import { MaxBetExceededError, RgLimitExceededError } from '@openora/core/contracts';

export function createGamingRouter({
  gaming,
  providers,
  categories,
  rules,
  membership,
  tags,
  bulk,
  adminGuard,
  sorts,
}: {
  gaming: GamingService;
  providers: GameProviderService;
  categories: GameCategoryService;
  rules: GameCategoryRuleService;
  membership: GameCategoryMembershipService;
  tags: GameTagService;
  bulk: GameBulkService;
  adminGuard: AdminGuard;
  sorts: GameSortService;
}) {
  const os = implement({ ...gamingContract, ...gamingAdminContract }).$context<OssContext>();

  // No built-in kind sets `exposesReporting`; an overlay's kind can. Checked on the exact
  // rule a write stores or an evaluation resolves, not one read earlier - see
  // docs/modules/gaming.md.
  function ruleReportingAccess(context: OssContext): GameCategoryRuleAuthorizer {
    return async (rule) => {
      if (rules.exposesReporting(rule)) {
        await adminGuard.assert(context, 'report', 'view');
      }
    };
  }

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
          BAD_REQUEST: [InsufficientBalanceError, MaxBetExceededError],
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
      return mapErrors(
        {
          CONFLICT: GameCategorySlugTakenError,
          BAD_REQUEST: [
            GameCategoryRuleRequiredError,
            GameCategoryRuleInvalidError,
            GameCategoryRuleTooBroadError,
          ],
          SERVICE_UNAVAILABLE: GameCategoryRuleUnavailableError,
        },
        () =>
          categories.createCategory({
            ...input,
            actorId: userId,
            ip,
            userAgent,
            authorizeRule: ruleReportingAccess(context),
          }),
      );
    }),

    updateCategory: os.updateCategory.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        {
          NOT_FOUND: GameCategoryNotFoundError,
          CONFLICT: [GameCategorySlugTakenError, GameCategoryUpdateContendedError],
          BAD_REQUEST: [
            GameSortConfigInvalidError,
            GameCategoryRuleRequiredError,
            GameCategoryRuleInvalidError,
            GameCategoryRuleTooBroadError,
          ],
          SERVICE_UNAVAILABLE: GameCategoryRuleUnavailableError,
        },
        () =>
          categories.updateCategory({
            ...input,
            actorId: userId,
            ip,
            userAgent,
            authorizeRule: ruleReportingAccess(context),
          }),
      );
    }),

    listCategoryGames: os.listCategoryGames.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      const { id, page, limit } = input;
      return mapErrors({ NOT_FOUND: GameCategoryNotFoundError }, () =>
        categories.listCategoryGames(id, { page, limit }),
      );
    }),

    reorderCategoryGames: os.reorderCategoryGames.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        {
          NOT_FOUND: GameCategoryNotFoundError,
          BAD_REQUEST: [CategoryGameNotMemberError, GameSortConfigInvalidError],
        },
        () => categories.reorderCategoryGames({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    updateCategoryPins: os.updateCategoryPins.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        {
          NOT_FOUND: GameCategoryNotFoundError,
          BAD_REQUEST: CategoryGameNotMemberError,
        },
        () => categories.updateCategoryPins({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    previewCategoryRule: os.previewCategoryRule.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      await ruleReportingAccess(context)(input.rule);
      return mapErrors(
        {
          BAD_REQUEST: [GameCategoryRuleInvalidError, GameCategoryRuleTooBroadError],
          SERVICE_UNAVAILABLE: GameCategoryRuleUnavailableError,
        },
        () => rules.preview(input),
      );
    }),

    evaluateCategoryMembership: os.evaluateCategoryMembership.handler(
      async ({ input, context }) => {
        const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
        return mapErrors(
          {
            NOT_FOUND: GameCategoryNotFoundError,
            CONFLICT: [GameCategoryNotRuleManagedError, GameCategoryMembershipContendedError],
            BAD_REQUEST: [GameCategoryRuleInvalidError, GameCategoryRuleTooBroadError],
            SERVICE_UNAVAILABLE: GameCategoryRuleUnavailableError,
          },
          () =>
            membership.evaluate({
              categoryId: input.id,
              trigger: 'admin',
              actor: { actorId: userId, ip, userAgent },
              authorizeRule: ruleReportingAccess(context),
            }),
        );
      },
    ),

    getCategoryRuleOptions: os.getCategoryRuleOptions.handler(async ({ context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return rules.listRuleOptions();
    }),

    getSortOptions: os.getSortOptions.handler(async ({ context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return sorts.listOptions();
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
          CONFLICT: [
            GameSlugTakenError,
            GameAggregatorNotMappedError,
            GameCategoryRuleManagedError,
          ],
        },
        () => gaming.updateGame({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    listAdminGames: os.listAdminGames.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      // Geo rules are compliance data; require the same grant compliance's own geo-rule routes do.
      if (
        input.geoBlocked !== undefined ||
        input.geoBlockedCountries ||
        input.geoAvailableCountries
      ) {
        await adminGuard.assert(context, 'compliance', 'view');
      }
      return mapErrors({ BAD_REQUEST: GameGeoFiltersUnavailableError }, () =>
        gaming.listGamesAdmin(input),
      );
    }),

    getCatalogStats: os.getCatalogStats.handler(async ({ context }) => {
      await adminGuard.assert(context, 'game-config', 'view');
      return gaming.getCatalogStats();
    }),

    setGamesActive: os.setGamesActive.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors({ BAD_REQUEST: GameBulkTooManyGamesError }, () =>
        bulk.setGamesActive({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    addGameTags: os.addGameTags.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        { NOT_FOUND: GameTagNotFoundError, BAD_REQUEST: GameBulkTooManyGamesError },
        () => bulk.addGameTags({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    addGameCategories: os.addGameCategories.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'game-config', 'update');
      return mapErrors(
        {
          NOT_FOUND: GameCategoryNotFoundError,
          CONFLICT: GameCategoryRuleManagedError,
          BAD_REQUEST: GameBulkTooManyGamesError,
        },
        () => bulk.addGameCategories({ ...input, actorId: userId, ip, userAgent }),
      );
    }),
  });
}

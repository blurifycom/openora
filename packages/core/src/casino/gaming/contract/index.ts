import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CountryCodeSchema,
  CurrencyTickerInputSchema,
  CurrencyTickerSchema,
  GAME_TYPES,
  GameBulkIdsSchema,
  GameBulkTargetFieldsSchema,
  gameBulkTargetRefinement,
  hasGameBulkTarget,
  GameCategoryMembershipModeSchema,
  GameCategoryMembershipTriggerSchema,
  GameCategoryNameSchema,
  GameCategoryRuleClauseSchema,
  GameCategoryRuleKeySchema,
  GameCategoryRuleSchema,
  GameCategorySummaryWithTranslationsSchema,
  GameCategoryTranslationsSchema,
  GameProviderAggregatorMappingSchema,
  GameSortDirectionSchema,
  GameSortKeySchema,
  GameSortParamsSchema,
  GameTagMetadataSchema,
  GameTagSummarySchema,
  GameTagTypeSchema,
  GameTagVisibilitySchema,
  GameProviderSummarySchema,
  GAME_REVIEW_STATUSES,
  GameReviewDecisionSchema,
  GameReviewStatusSchema,
  GameTypeSchema,
  IdInputSchema,
  JsonSchemaDocumentSchema,
  MoneyAmountSchema,
  PageQuerySchema,
  QueryBooleanSchema,
  TimestampSchema,
  UuidSchema,
  createKebabSlugSchema,
  paginated,
  queryArraySchema,
  queue,
} from '@openora/core/contracts';

export {
  GameReviewDecisionSchema,
  GameReviewStatusSchema,
  GameTypeSchema,
} from '@openora/core/contracts';
export { GameProviderSummarySchema } from '@openora/core/contracts';
export { GameProviderAggregatorMappingSchema } from '@openora/core/contracts';
export { GameCategorySummarySchema } from '@openora/core/contracts';
export { GameCategorySummaryWithTranslationsSchema } from '@openora/core/contracts';
export { GameCategoryTranslationsSchema } from '@openora/core/contracts';
export {
  GameSortDirectionSchema,
  GameSortKeySchema,
  GameSortParamsSchema,
} from '@openora/core/contracts';
export { GameCategoryMembershipModeSchema, GameCategoryRuleSchema } from '@openora/core/contracts';
export {
  GameTagMetadataSchema,
  GameTagSummarySchema,
  GameTagTypeSchema,
  GameTagVisibilitySchema,
} from '@openora/core/contracts';

export const GAME_ROUND_STATUSES = ['active', 'completed', 'cancelled'] as const;
export const GameRoundStatusSchema = z.enum(GAME_ROUND_STATUSES);
export type GameRoundStatus = z.infer<typeof GameRoundStatusSchema>;

export const GameSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  provider: GameProviderSummarySchema,
  aggregator: z.string(),
  categories: z.array(GameCategorySummaryWithTranslationsSchema),
  tags: z.array(GameTagSummarySchema),
  gameType: GameTypeSchema,
  thumbnailUrl: z.string().nullable(),
  customThumbnailUrl: z.string().nullable(),
  isActive: z.boolean(),
  isUnavailable: z.boolean(),
  metadata: z.unknown().nullable(),
});

export const AdminGameSchema = GameSchema.extend({
  reviewStatus: GameReviewStatusSchema,
  reviewedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type AdminGame = z.infer<typeof AdminGameSchema>;

export const GameRoundSchema = z.object({
  id: UuidSchema,
  gameId: UuidSchema,
  userId: UuidSchema,
  status: GameRoundStatusSchema,
  betAmount: MoneyAmountSchema,
  winAmount: MoneyAmountSchema,
  currency: CurrencyTickerSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type GameRound = z.infer<typeof GameRoundSchema>;

export const PositiveMoneyAmountSchema = MoneyAmountSchema.refine((v) => Number(v) > 0, {
  message: 'must be greater than zero',
});

export const StartRoundInputSchema = z.object({
  gameId: UuidSchema,
  currency: CurrencyTickerInputSchema,
  betAmount: PositiveMoneyAmountSchema,
});

export const StartRoundOutputSchema = z.object({
  roundId: UuidSchema,
  launchUrl: z.string(),
  token: z.string(),
});

export const EndRoundInputSchema = z.object({
  roundId: UuidSchema,
});

export const EndRoundOutputSchema = z.object({
  success: z.literal(true),
  winAmount: MoneyAmountSchema,
});

const CatalogQueryBaseSchema = z.object({
  ...PageQuerySchema.shape,
  q: z.string().trim().min(1).max(64).optional(),
});

export const ListGamesInputSchema = CatalogQueryBaseSchema.extend({
  providerId: UuidSchema.optional(),
  categoryId: UuidSchema.optional(),
});
export type ListGamesInput = z.infer<typeof ListGamesInputSchema>;

export const CatalogSlugSchema = createKebabSlugSchema(64);

export const GAME_FAVORITE_LIMIT = 200;

export const GameFavoriteInputSchema = z.object({ gameId: UuidSchema });
export type GameFavoriteInput = z.infer<typeof GameFavoriteInputSchema>;

export const GameFavoriteAckSchema = z.object({ success: z.literal(true) });

export const gamingContract = {
  listGames: oc
    .route({ method: 'GET', path: '/gaming/games' })
    .input(ListGamesInputSchema)
    .output(paginated(GameSchema)),

  getGame: oc
    .route({ method: 'GET', path: '/gaming/games/{id}' })
    .input(IdInputSchema)
    .output(GameSchema),

  getGameBySlug: oc
    .route({ method: 'GET', path: '/gaming/games/by-slug/{slug}' })
    .input(z.object({ slug: CatalogSlugSchema }))
    .output(GameSchema),

  startRound: oc
    .route({ method: 'POST', path: '/gaming/rounds/start' })
    .input(StartRoundInputSchema)
    .output(StartRoundOutputSchema),

  endRound: oc
    .route({ method: 'POST', path: '/gaming/rounds/{roundId}/end' })
    .input(EndRoundInputSchema)
    .output(EndRoundOutputSchema),

  listRounds: oc.route({ method: 'GET', path: '/gaming/rounds' }).output(z.array(GameRoundSchema)),

  listProviders: oc
    .route({ method: 'GET', path: '/gaming/providers' })
    .input(PageQuerySchema.extend({ categoryId: UuidSchema.optional() }))
    .output(paginated(GameProviderSummarySchema)),

  getProviderBySlug: oc
    .route({ method: 'GET', path: '/gaming/providers/{slug}' })
    .input(z.object({ slug: CatalogSlugSchema }))
    .output(GameProviderSummarySchema),

  listCategories: oc
    .route({ method: 'GET', path: '/gaming/categories' })
    .input(PageQuerySchema)
    .output(paginated(GameCategorySummaryWithTranslationsSchema)),

  getCategoryBySlug: oc
    .route({ method: 'GET', path: '/gaming/categories/{slug}' })
    .input(z.object({ slug: CatalogSlugSchema }))
    .output(GameCategorySummaryWithTranslationsSchema),

  listFavorites: oc.route({ method: 'GET', path: '/gaming/favorites' }).output(z.array(GameSchema)),

  listFavoriteIds: oc
    .route({ method: 'GET', path: '/gaming/favorites/ids' })
    .output(z.array(UuidSchema)),

  addFavorite: oc
    .route({ method: 'POST', path: '/gaming/favorites' })
    .input(GameFavoriteInputSchema)
    .output(GameFavoriteAckSchema),

  removeFavorite: oc
    .route({ method: 'DELETE', path: '/gaming/favorites/{gameId}' })
    .input(GameFavoriteInputSchema)
    .output(GameFavoriteAckSchema),
};

export const GameProviderDetailSchema = GameProviderSummarySchema.extend({
  aggregatorMappings: z.array(GameProviderAggregatorMappingSchema),
  metadata: z.unknown().nullable(),
  isActive: z.boolean(),
  autoApproveNewGames: z.boolean(),
  pendingReviewCount: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type GameProviderDetail = z.infer<typeof GameProviderDetailSchema>;
/** @alias */
export const GameProviderSchema = GameProviderDetailSchema;

export const GameCategoryDetailSchema = GameCategorySummaryWithTranslationsSchema.extend({
  isActive: z.boolean(),
  sortKey: GameSortKeySchema,
  sortDirection: GameSortDirectionSchema.nullable(),
  sortParams: GameSortParamsSchema,
  rankedAt: TimestampSchema.nullable(),
  membershipMode: GameCategoryMembershipModeSchema,
  membershipRule: GameCategoryRuleSchema.nullable(),
  membershipEvaluatedAt: TimestampSchema.nullable(),
  membershipAttemptedAt: TimestampSchema.nullable(),
  membershipLastError: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type GameCategoryDetail = z.infer<typeof GameCategoryDetailSchema>;
/** @alias */
export const GameCategorySchema = GameCategoryDetailSchema;

const CatalogFilterSchema = CatalogQueryBaseSchema.extend({
  isActive: QueryBooleanSchema.optional(),
});

export const ListAdminProvidersInputSchema = CatalogFilterSchema.extend({
  ids: queryArraySchema(UuidSchema, 50).optional(),
});
export type ListAdminProvidersInput = z.infer<typeof ListAdminProvidersInputSchema>;

export const ListAdminGamesInputSchema = ListGamesInputSchema.extend({
  isActive: QueryBooleanSchema.optional(),
  isUnavailable: QueryBooleanSchema.optional(),
  categoryIds: queryArraySchema(UuidSchema, 50).optional(),
  uncategorized: QueryBooleanSchema.optional(),
  tagIds: queryArraySchema(UuidSchema, 50).optional(),
  gameTypes: queryArraySchema(GameTypeSchema, GAME_TYPES.length).optional(),
  reviewStatuses: queryArraySchema(GameReviewStatusSchema, GAME_REVIEW_STATUSES.length).optional(),
  geoBlocked: QueryBooleanSchema.optional(),
  geoBlockedCountries: queryArraySchema(CountryCodeSchema, 50).optional(),
  geoAvailableCountries: queryArraySchema(CountryCodeSchema, 50).optional(),
})
  .refine(
    (input) => !(input.uncategorized === true && (input.categoryId || input.categoryIds?.length)),
    { message: 'uncategorized cannot be combined with a category filter', path: ['uncategorized'] },
  )
  .refine((input) => !(input.geoBlocked === false && input.geoBlockedCountries?.length), {
    message: 'geoBlocked=false cannot be combined with geoBlockedCountries',
    path: ['geoBlocked'],
  })
  .refine((input) => !(input.geoBlocked === true && input.geoAvailableCountries?.length), {
    message: 'geoBlocked=true cannot be combined with geoAvailableCountries',
    path: ['geoAvailableCountries'],
  })
  .refine(
    (input) =>
      !input.geoBlockedCountries?.length ||
      !input.geoAvailableCountries?.length ||
      !input.geoBlockedCountries.some((code) => input.geoAvailableCountries?.includes(code)),
    {
      message: 'geoAvailableCountries cannot share a country with geoBlockedCountries',
      path: ['geoAvailableCountries'],
    },
  );
export type ListAdminGamesInput = z.infer<typeof ListAdminGamesInputSchema>;

export const ADMIN_GAME_RULE_CLAUSES_MAX = 5;

export const ADMIN_GAME_RULE_MATCH_MAX = 20_000;

export const SearchAdminGamesInputSchema = ListAdminGamesInputSchema.safeExtend({
  rules: z.array(GameCategoryRuleClauseSchema).max(ADMIN_GAME_RULE_CLAUSES_MAX).optional(),
});
export type SearchAdminGamesInput = z.infer<typeof SearchAdminGamesInputSchema>;

export type GameSearchRuleTooBroadData = {
  reason: 'rule_filter_too_broad';
  matchedCount: number;
  max: number;
};

const CatalogCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  inactive: z.number().int().nonnegative(),
});

export const CatalogStatsSchema = z.object({
  providers: CatalogCountsSchema.extend({
    autoApprove: z.number().int().nonnegative(),
  }),
  categories: CatalogCountsSchema,
  games: CatalogCountsSchema.extend({
    unavailable: z.number().int().nonnegative(),
    playable: z.number().int().nonnegative(),
    pendingReview: z.number().int().nonnegative(),
  }),
});
export type CatalogStats = z.infer<typeof CatalogStatsSchema>;

const ProviderAggregatorMappingsInputSchema = z
  .array(GameProviderAggregatorMappingSchema)
  .max(50)
  .superRefine((mappings, ctx) => {
    const seen = new Set<string>();
    for (const [index, mapping] of mappings.entries()) {
      if (seen.has(mapping.aggregator)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each aggregator can be mapped only once',
          path: [index, 'aggregator'],
        });
      }
      seen.add(mapping.aggregator);
    }
  });

const CustomImageUrlSchema = z
  .url({ protocol: /^https$/, normalize: true, abort: true })
  .max(512)
  .refine(
    (v) => {
      const url = new URL(v);
      return url.username === '' && url.password === '';
    },
    { message: 'must not embed credentials' },
  );

const ProviderWriteFieldsSchema = z.object({
  slug: CatalogSlugSchema,
  name: z.string().trim().min(1).max(128),
  aggregatorMappings: ProviderAggregatorMappingsInputSchema,
  logoUrl: z.string().trim().min(1).max(512).nullable(),
  metadata: z.unknown().nullable(),
});

export const CreateProviderInputSchema = ProviderWriteFieldsSchema.pick({
  slug: true,
  name: true,
}).extend({
  aggregatorMappings: ProviderAggregatorMappingsInputSchema.optional(),
  logoUrl: ProviderWriteFieldsSchema.shape.logoUrl.optional(),
  metadata: ProviderWriteFieldsSchema.shape.metadata.optional(),
});
export type CreateProviderInput = z.infer<typeof CreateProviderInputSchema>;

export const UpdateProviderInputSchema = ProviderWriteFieldsSchema.partial().extend({
  id: UuidSchema,
  isActive: z.boolean().optional(),
  autoApproveNewGames: z.boolean().optional(),
  customLogoUrl: CustomImageUrlSchema.nullable().optional(),
});
export type UpdateProviderInput = z.infer<typeof UpdateProviderInputSchema>;

export const CreateCategoryInputSchema = z.object({
  slug: CatalogSlugSchema,
  name: GameCategoryNameSchema,
  translations: GameCategoryTranslationsSchema.optional(),
  icon: z.string().trim().min(1).max(512).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  membershipMode: GameCategoryMembershipModeSchema.optional(),
  membershipRule: GameCategoryRuleSchema.optional(),
});
export type CreateCategoryInput = z.infer<typeof CreateCategoryInputSchema>;

export const UpdateCategoryInputSchema = z.object({
  id: UuidSchema,
  slug: CatalogSlugSchema.optional(),
  name: GameCategoryNameSchema.optional(),
  translations: GameCategoryTranslationsSchema.optional(),
  icon: z.string().trim().min(1).max(512).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  sortKey: GameSortKeySchema.optional(),
  sortDirection: GameSortDirectionSchema.nullable().optional(),
  sortParams: GameSortParamsSchema.optional(),
  membershipMode: GameCategoryMembershipModeSchema.optional(),
  membershipRule: GameCategoryRuleSchema.optional(),
});
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInputSchema>;

export const GAME_CATEGORY_GAMES_ORDER_MAX = 2000;

export const CategoryGameItemSchema = GameSchema.pick({
  id: true,
  name: true,
  slug: true,
  provider: true,
  thumbnailUrl: true,
  customThumbnailUrl: true,
  isActive: true,
}).extend({
  position: z.number().int().nullable(),
  pinnedPosition: z.number().int().nullable(),
  isPlayable: z.boolean(),
});

export const ListCategoryGamesInputSchema = PageQuerySchema.extend({
  id: UuidSchema,
});
export type ListCategoryGamesInput = z.infer<typeof ListCategoryGamesInputSchema>;

export const CategoryGamesPageSchema = paginated(CategoryGameItemSchema);
export type CategoryGamesPage = z.infer<typeof CategoryGamesPageSchema>;

export const ReorderCategoryGamesInputSchema = z.object({
  id: UuidSchema,
  gameIds: z
    .array(UuidSchema)
    .min(1)
    .max(GAME_CATEGORY_GAMES_ORDER_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'gameIds must be unique' }),
});
export type ReorderCategoryGamesInput = z.infer<typeof ReorderCategoryGamesInputSchema>;

export const ReorderCategoryGamesOutputSchema = z.object({
  sortKey: GameSortKeySchema,
  sortDirection: GameSortDirectionSchema.nullable(),
  sortParams: GameSortParamsSchema,
});

export const GAME_CATEGORY_PINS_MAX = 100;

const CategoryPinItemSchema = z.object({
  gameId: UuidSchema,
  position: z.number().int().min(0).max(GAME_CATEGORY_GAMES_ORDER_MAX),
});

export const UpdateCategoryPinsInputSchema = z.object({
  id: UuidSchema,
  pins: z
    .array(CategoryPinItemSchema)
    .max(GAME_CATEGORY_PINS_MAX)
    .superRefine((pins, ctx) => {
      const seenGameIds = new Set<string>();
      const seenPositions = new Set<number>();
      for (const [index, pin] of pins.entries()) {
        if (seenGameIds.has(pin.gameId)) {
          ctx.addIssue({
            code: 'custom',
            message: 'gameId must be unique',
            path: [index, 'gameId'],
          });
        }
        seenGameIds.add(pin.gameId);
        if (seenPositions.has(pin.position)) {
          ctx.addIssue({
            code: 'custom',
            message: 'position must be unique',
            path: [index, 'position'],
          });
        }
        seenPositions.add(pin.position);
      }
    }),
});
export type UpdateCategoryPinsInput = z.infer<typeof UpdateCategoryPinsInputSchema>;

export const UpdateCategoryPinsOutputSchema = z.object({
  pins: z.array(z.object({ gameId: UuidSchema, position: z.number().int().nonnegative() })),
});

export const GameCategoryRuleOptionSchema = z.object({
  key: GameCategoryRuleKeySchema,
  exposesReporting: z.boolean(),
  paramsJsonSchema: JsonSchemaDocumentSchema,
});
export type GameCategoryRuleOption = z.infer<typeof GameCategoryRuleOptionSchema>;

export const GameSortOptionSchema = z.object({
  key: GameSortKeySchema,
  directions: z.array(GameSortDirectionSchema).min(1),
  paramsJsonSchema: JsonSchemaDocumentSchema,
});
export type GameSortOption = z.infer<typeof GameSortOptionSchema>;

export const GAME_CATEGORY_RANK_QUEUE = queue('gaming.category.rank');

export const GameCategoryRankJobSchema = z.object({
  categoryId: UuidSchema,
});
export type GameCategoryRankJob = z.infer<typeof GameCategoryRankJobSchema>;

export const GAME_CATEGORY_RANK_SWEEP_QUEUE = queue('gaming.category.rank-sweep');

export const GameCategoryRankSweepJobSchema = z.object({});

export const LEDGER_GAME_RECONCILE_QUEUE = queue('gaming.ledger-game.reconcile');

export const LedgerGameReconcileJobSchema = z.object({});

export const LEDGER_GAME_RECONCILE_INTERVAL_MS = 60_000;

export const RANK_SWEEP_INTERVAL_MS = 60_000;

export const RANK_SWEEP_BATCH_LIMIT = 200;

export const RANK_RETRY_BASE_MS = 120_000;
export const RANK_RETRY_MAX_MS = 3_600_000;

export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export const PreviewCategoryRuleInputSchema = PageQuerySchema.extend({
  rule: GameCategoryRuleSchema,
});
export type PreviewCategoryRuleInput = z.infer<typeof PreviewCategoryRuleInputSchema>;

export const CategoryRulePreviewItemSchema = GameSchema.pick({
  id: true,
  name: true,
  slug: true,
  provider: true,
  thumbnailUrl: true,
  customThumbnailUrl: true,
  isActive: true,
});

export const CategoryRulePreviewSchema = paginated(CategoryRulePreviewItemSchema);
export type CategoryRulePreview = z.infer<typeof CategoryRulePreviewSchema>;

export const EvaluateCategoryMembershipOutputSchema = z.object({
  matchedCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  evaluatedAt: TimestampSchema,
});
export type EvaluateCategoryMembershipOutput = z.infer<
  typeof EvaluateCategoryMembershipOutputSchema
>;

export const GAME_CATEGORY_RULE_MATCH_MAX = 5000;

export const MEMBERSHIP_SWEEP_BATCH_LIMIT = 200;

export const MEMBERSHIP_EVENT_DEBOUNCE_MS = 250;

export const GAMES_CREATED_EVENT_BATCH = 1000;

export const GAMES_CHANGED_EVENT_BATCH = 1000;

export const GAME_CATEGORY_MEMBERSHIP_QUEUE = queue('gaming.category.membership');

export const GameCategoryMembershipJobSchema = z.object({
  categoryId: UuidSchema,
  trigger: GameCategoryMembershipTriggerSchema.exclude(['admin']),
});
export type GameCategoryMembershipJob = z.infer<typeof GameCategoryMembershipJobSchema>;

export const GAME_CATEGORY_MEMBERSHIP_SWEEP_QUEUE = queue('gaming.category.membership-sweep');

export const GameCategoryMembershipSweepJobSchema = z.object({});

export const MEMBERSHIP_SWEEP_CRON = '15 * * * *';

export const GameTagDetailSchema = GameTagSummarySchema.extend({
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type GameTagDetail = z.infer<typeof GameTagDetailSchema>;
/** @alias */
export const GameTagSchema = GameTagDetailSchema;

export const CreateGameTagInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  visibility: GameTagVisibilitySchema.default('invisible'),
  metadata: GameTagMetadataSchema.nullable().optional(),
});
export type CreateGameTagInput = z.infer<typeof CreateGameTagInputSchema>;

export const UpdateGameTagInputSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(128).optional(),
  visibility: GameTagVisibilitySchema.optional(),
  metadata: GameTagMetadataSchema.nullable().optional(),
});
export type UpdateGameTagInput = z.infer<typeof UpdateGameTagInputSchema>;

export const ListAdminTagsInputSchema = CatalogQueryBaseSchema.extend({
  type: GameTagTypeSchema.optional(),
  visibility: GameTagVisibilitySchema.optional(),
});
export type ListAdminTagsInput = z.infer<typeof ListAdminTagsInputSchema>;

export const UpdateGameInputSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(256).optional(),
  slug: CatalogSlugSchema.optional(),
  providerId: UuidSchema.optional(),
  aggregator: z.string().trim().min(1).max(64).optional(),
  thumbnailUrl: z.string().trim().min(1).max(512).nullable().optional(),
  customThumbnailUrl: CustomImageUrlSchema.nullable().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().nullable().optional(),
  categoryIds: z.array(UuidSchema).max(50).optional(),
  tagIds: z.array(UuidSchema).max(50).optional(),
});
export type UpdateGameInput = z.infer<typeof UpdateGameInputSchema>;

export const SetGamesActiveInputSchema = GameBulkTargetFieldsSchema.extend({
  isActive: z.boolean(),
}).refine(hasGameBulkTarget, gameBulkTargetRefinement);
export type SetGamesActiveInput = z.infer<typeof SetGamesActiveInputSchema>;

export const AddGameTagsInputSchema = GameBulkTargetFieldsSchema.extend({
  tagIds: z.array(UuidSchema).min(1).max(50),
}).refine(hasGameBulkTarget, gameBulkTargetRefinement);
export type AddGameTagsInput = z.infer<typeof AddGameTagsInputSchema>;

export const AddGameCategoriesInputSchema = GameBulkTargetFieldsSchema.extend({
  categoryIds: z.array(UuidSchema).min(1).max(50),
}).refine(hasGameBulkTarget, gameBulkTargetRefinement);
export type AddGameCategoriesInput = z.infer<typeof AddGameCategoriesInputSchema>;

const BulkCountSchema = z.object({
  updatedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
});

export const AddGameLinksOutputSchema = z.object({
  games: BulkCountSchema,
  notFound: GameBulkIdsSchema,
});
export type AddGameLinksOutput = z.infer<typeof AddGameLinksOutputSchema>;

export const SetGamesActiveOutputSchema = z.object({
  games: BulkCountSchema,
  providers: BulkCountSchema,
  notFound: GameBulkIdsSchema,
  unplayableGameIds: z.array(UuidSchema),
  reviewSkippedCount: z.number().int().nonnegative(),
});
export type SetGamesActiveOutput = z.infer<typeof SetGamesActiveOutputSchema>;

export const ReviewGameInputSchema = IdInputSchema.extend({
  decision: GameReviewDecisionSchema,
});
export type ReviewGameInput = z.infer<typeof ReviewGameInputSchema>;

export const ReviewGamesInputSchema = GameBulkTargetFieldsSchema.extend({
  decision: GameReviewDecisionSchema,
}).refine(hasGameBulkTarget, gameBulkTargetRefinement);
export type ReviewGamesInput = z.infer<typeof ReviewGamesInputSchema>;

export const ReviewGamesOutputSchema = z.object({
  games: BulkCountSchema,
  notFound: GameBulkIdsSchema,
  unplayableGameIds: z.array(UuidSchema),
});
export type ReviewGamesOutput = z.infer<typeof ReviewGamesOutputSchema>;

export const gamingAdminContract = {
  listAdminProviders: oc
    .route({ method: 'GET', path: '/backoffice/gaming/providers' })
    .input(ListAdminProvidersInputSchema)
    .output(paginated(GameProviderDetailSchema)),

  getAdminProvider: oc
    .route({ method: 'GET', path: '/backoffice/gaming/providers/{id}' })
    .input(IdInputSchema)
    .output(GameProviderDetailSchema),

  createProvider: oc
    .route({ method: 'POST', path: '/backoffice/gaming/providers' })
    .input(CreateProviderInputSchema)
    .output(GameProviderDetailSchema),

  updateProvider: oc
    .route({ method: 'PATCH', path: '/backoffice/gaming/providers/{id}' })
    .input(UpdateProviderInputSchema)
    .output(GameProviderDetailSchema),

  listAdminCategories: oc
    .route({ method: 'GET', path: '/backoffice/gaming/categories' })
    .input(CatalogFilterSchema)
    .output(paginated(GameCategoryDetailSchema)),

  getAdminCategory: oc
    .route({ method: 'GET', path: '/backoffice/gaming/categories/{id}' })
    .input(IdInputSchema)
    .output(GameCategoryDetailSchema),

  createCategory: oc
    .route({ method: 'POST', path: '/backoffice/gaming/categories' })
    .input(CreateCategoryInputSchema)
    .output(GameCategoryDetailSchema),

  updateCategory: oc
    .route({ method: 'PATCH', path: '/backoffice/gaming/categories/{id}' })
    .input(UpdateCategoryInputSchema)
    .output(GameCategoryDetailSchema),

  listAdminTags: oc
    .route({ method: 'GET', path: '/backoffice/gaming/tags' })
    .input(ListAdminTagsInputSchema)
    .output(paginated(GameTagDetailSchema)),

  getAdminTag: oc
    .route({ method: 'GET', path: '/backoffice/gaming/tags/{id}' })
    .input(IdInputSchema)
    .output(GameTagDetailSchema),

  createTag: oc
    .route({ method: 'POST', path: '/backoffice/gaming/tags' })
    .input(CreateGameTagInputSchema)
    .output(GameTagDetailSchema),

  updateTag: oc
    .route({ method: 'PATCH', path: '/backoffice/gaming/tags/{id}' })
    .input(UpdateGameTagInputSchema)
    .output(GameTagDetailSchema),

  deleteTag: oc
    .route({ method: 'DELETE', path: '/backoffice/gaming/tags/{id}' })
    .input(IdInputSchema)
    .output(z.boolean()),

  updateGame: oc
    .route({ method: 'PATCH', path: '/backoffice/gaming/games/{id}' })
    .input(UpdateGameInputSchema)
    .output(AdminGameSchema),

  listAdminGames: oc
    .route({ method: 'GET', path: '/backoffice/gaming/games' })
    .input(ListAdminGamesInputSchema)
    .output(paginated(AdminGameSchema)),

  searchAdminGames: oc
    .route({ method: 'POST', path: '/backoffice/gaming/games/search' })
    .input(SearchAdminGamesInputSchema)
    .output(paginated(AdminGameSchema)),

  reviewGame: oc
    .route({ method: 'POST', path: '/backoffice/gaming/games/{id}/review' })
    .input(ReviewGameInputSchema)
    .output(AdminGameSchema),

  reviewGames: oc
    .route({ method: 'POST', path: '/backoffice/gaming/games/bulk/review' })
    .input(ReviewGamesInputSchema)
    .output(ReviewGamesOutputSchema),

  getCatalogStats: oc
    .route({ method: 'GET', path: '/backoffice/gaming/stats' })
    .output(CatalogStatsSchema),

  setGamesActive: oc
    .route({ method: 'POST', path: '/backoffice/gaming/games/bulk/active' })
    .input(SetGamesActiveInputSchema)
    .output(SetGamesActiveOutputSchema),

  addGameTags: oc
    .route({ method: 'POST', path: '/backoffice/gaming/games/bulk/tags' })
    .input(AddGameTagsInputSchema)
    .output(AddGameLinksOutputSchema),

  addGameCategories: oc
    .route({ method: 'POST', path: '/backoffice/gaming/games/bulk/categories' })
    .input(AddGameCategoriesInputSchema)
    .output(AddGameLinksOutputSchema),

  listCategoryGames: oc
    .route({ method: 'GET', path: '/backoffice/gaming/categories/{id}/games' })
    .input(ListCategoryGamesInputSchema)
    .output(CategoryGamesPageSchema),

  reorderCategoryGames: oc
    .route({ method: 'PUT', path: '/backoffice/gaming/categories/{id}/games/order' })
    .input(ReorderCategoryGamesInputSchema)
    .output(ReorderCategoryGamesOutputSchema),

  updateCategoryPins: oc
    .route({ method: 'PUT', path: '/backoffice/gaming/categories/{id}/games/pins' })
    .input(UpdateCategoryPinsInputSchema)
    .output(UpdateCategoryPinsOutputSchema),

  previewCategoryRule: oc
    .route({ method: 'POST', path: '/backoffice/gaming/categories/rule-preview' })
    .input(PreviewCategoryRuleInputSchema)
    .output(CategoryRulePreviewSchema),

  evaluateCategoryMembership: oc
    .route({ method: 'POST', path: '/backoffice/gaming/categories/{id}/membership/evaluate' })
    .input(IdInputSchema)
    .output(EvaluateCategoryMembershipOutputSchema),

  getCategoryRuleOptions: oc
    .route({ method: 'GET', path: '/backoffice/gaming/category-rule-options' })
    .output(z.array(GameCategoryRuleOptionSchema)),

  getSortOptions: oc
    .route({ method: 'GET', path: '/backoffice/gaming/sort-options' })
    .output(z.array(GameSortOptionSchema)),
};
export * from './agent-tools.js';

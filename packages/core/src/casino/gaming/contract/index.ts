import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CountryCodeSchema,
  CurrencyCodeSchema,
  GAME_TYPES,
  GameBulkIdsSchema,
  GameCategoryMembershipModeSchema,
  GameCategoryMembershipTriggerSchema,
  GameCategoryNameSchema,
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

export { GameTypeSchema } from '@openora/core/contracts';
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
  // Source channel code (eg 'eventmatrix'); 'direct' = directly integrated.
  aggregator: z.string(),
  categories: z.array(GameCategorySummaryWithTranslationsSchema),
  tags: z.array(GameTagSummarySchema),
  gameType: GameTypeSchema,
  thumbnailUrl: z.string().nullable(),
  isActive: z.boolean(),
  isUnavailable: z.boolean(),
  metadata: z.unknown().nullable(),
});

export const GameRoundSchema = z.object({
  id: UuidSchema,
  gameId: UuidSchema,
  userId: UuidSchema,
  status: GameRoundStatusSchema,
  betAmount: MoneyAmountSchema,
  winAmount: MoneyAmountSchema,
  currency: CurrencyCodeSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type GameRound = z.infer<typeof GameRoundSchema>;

export const PositiveMoneyAmountSchema = MoneyAmountSchema.refine((v) => Number(v) > 0, {
  message: 'must be greater than zero',
});

export const StartRoundInputSchema = z.object({
  gameId: UuidSchema,
  currency: CurrencyCodeSchema,
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
  // What the round paid, in its own currency - '0' for a losing round. The provider's
  // number: the player never sends it and cannot influence it.
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

export const gamingContract = {
  listGames: oc
    .route({ method: 'GET', path: '/gaming/games' })
    .input(ListGamesInputSchema)
    .output(paginated(GameSchema)),

  getGame: oc
    .route({ method: 'GET', path: '/gaming/games/{id}' })
    .input(IdInputSchema)
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
    .input(PageQuerySchema)
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
};

// Backoffice catalog management (game-config guarded in the router).

export const GameProviderDetailSchema = GameProviderSummarySchema.extend({
  aggregatorMappings: z.array(GameProviderAggregatorMappingSchema),
  metadata: z.unknown().nullable(),
  isActive: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type GameProviderDetail = z.infer<typeof GameProviderDetailSchema>;
// Alias kept for existing imports; new code uses GameProviderDetailSchema.
export const GameProviderSchema = GameProviderDetailSchema;

export const GameCategoryDetailSchema = GameCategorySummaryWithTranslationsSchema.extend({
  isActive: z.boolean(),
  sortKey: GameSortKeySchema,
  sortDirection: GameSortDirectionSchema.nullable(),
  sortParams: GameSortParamsSchema,
  rankedAt: TimestampSchema.nullable(),
  membershipMode: GameCategoryMembershipModeSchema,
  membershipRule: GameCategoryRuleSchema.nullable(),
  // When the games last matched the rule. Unchanged by a failed evaluation, so a rule
  // that has stopped resolving shows an old timestamp next to membershipLastError.
  membershipEvaluatedAt: TimestampSchema.nullable(),
  membershipAttemptedAt: TimestampSchema.nullable(),
  membershipLastError: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type GameCategoryDetail = z.infer<typeof GameCategoryDetailSchema>;
// Alias kept for existing imports; new code uses GameCategoryDetailSchema.
export const GameCategorySchema = GameCategoryDetailSchema;

const CatalogFilterSchema = CatalogQueryBaseSchema.extend({
  isActive: QueryBooleanSchema.optional(),
});

export const ListAdminGamesInputSchema = ListGamesInputSchema.extend({
  isActive: QueryBooleanSchema.optional(),
  isUnavailable: QueryBooleanSchema.optional(),
  categoryIds: queryArraySchema(UuidSchema, 50).optional(),
  uncategorized: QueryBooleanSchema.optional(),
  tagIds: queryArraySchema(UuidSchema, 50).optional(),
  gameTypes: queryArraySchema(GameTypeSchema, GAME_TYPES.length).optional(),
  geoBlocked: QueryBooleanSchema.optional(),
  geoBlockedCountries: queryArraySchema(CountryCodeSchema, 50).optional(),
  // "Available in X": the inverse of geoBlockedCountries - a game with no game or provider
  // rule for any of these countries. See ComplianceService.checkGame for the same precedence.
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

// `active` and `inactive` count each row's own `isActive` flag, matching the admin list filters.
const CatalogCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  inactive: z.number().int().nonnegative(),
});

export const CatalogStatsSchema = z.object({
  providers: CatalogCountsSchema,
  categories: CatalogCountsSchema,
  games: CatalogCountsSchema.extend({
    unavailable: z.number().int().nonnegative(),
    // Active, available games whose provider is active too: what a player can actually launch.
    playable: z.number().int().nonnegative(),
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
});
export type UpdateProviderInput = z.infer<typeof UpdateProviderInputSchema>;

export const CreateCategoryInputSchema = z.object({
  slug: CatalogSlugSchema,
  name: GameCategoryNameSchema,
  translations: GameCategoryTranslationsSchema.optional(),
  icon: z.string().trim().min(1).max(512).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  // 'rule' needs a membershipRule in the same call; the service rejects it otherwise.
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
  // Switching to 'rule' needs a rule - sent here or stored by an earlier write.
  // Switching back to 'manual' keeps both the stored rule and the current games.
  membershipMode: GameCategoryMembershipModeSchema.optional(),
  membershipRule: GameCategoryRuleSchema.optional(),
});
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInputSchema>;

export const GAME_CATEGORY_GAMES_ORDER_MAX = 2000;

// admin-only: `pinnedPosition` must never appear on a public-facing schema.
export const CategoryGameItemSchema = GameSchema.pick({
  id: true,
  name: true,
  slug: true,
  provider: true,
  thumbnailUrl: true,
  isActive: true,
}).extend({
  position: z.number().int().nullable(),
  pinnedPosition: z.number().int().nullable(),
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
  // A drag always ends in manual sort - see docs/modules/gaming.md. Returned so the caller's config
  // view stays consistent without a follow-up GET.
  sortKey: GameSortKeySchema,
  sortDirection: GameSortDirectionSchema.nullable(),
  sortParams: GameSortParamsSchema,
});

export const GAME_CATEGORY_PINS_MAX = 100;

const CategoryPinItemSchema = z.object({
  gameId: UuidSchema,
  // Capped at the same bound as a manual reorder's gameIds list - a slot can never be
  // meaningfully further out than the largest category the platform allows, and this
  // keeps an out-of-range value a 400 rather than a Postgres ::int overflow (500).
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

// Echoes the full resulting pinned-slot list (ordered by position), so the caller's
// config view stays consistent without a follow-up GET - the same rationale as
// ReorderCategoryGamesOutputSchema above.
export const UpdateCategoryPinsOutputSchema = z.object({
  pins: z.array(z.object({ gameId: UuidSchema, position: z.number().int().nonnegative() })),
});

export const GameCategoryRuleOptionSchema = z.object({
  key: GameCategoryRuleKeySchema,
  // Previewing a rule with this kind of clause also needs report:view. False for every built-in.
  exposesReporting: z.boolean(),
  // A JSON Schema document (z.toJSONSchema of the definition's paramsSchema).
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

// Durable backstop for a lost post-commit rank enqueue - see docs/modules/gaming.md.
export const GAME_CATEGORY_RANK_SWEEP_QUEUE = queue('gaming.category.rank-sweep');

export const GameCategoryRankSweepJobSchema = z.object({});

// How often the sweep looks for a category whose rank fell behind its last change.
export const RANK_SWEEP_INTERVAL_MS = 60_000;

// Cap on how many dirty categories one sweep pass enqueues (oldest rankDirtyAt first),
// so a large backlog drains gradually across passes instead of compounding every
// interval - see docs/modules/gaming.md.
export const RANK_SWEEP_BATCH_LIMIT = 200;

// After a failed rank run the sweep waits RANK_RETRY_BASE_MS, doubling per consecutive
// failure up to RANK_RETRY_MAX_MS, so a sort that keeps failing is not retried every pass.
export const RANK_RETRY_BASE_MS = 120_000;
export const RANK_RETRY_MAX_MS = 3_600_000;

// Actor recorded on a membership evaluation no admin asked for (event-driven, scheduled).
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

// The most games one rule may match; preview and evaluation reject a broader result
// before any membership write.
export const GAME_CATEGORY_RULE_MATCH_MAX = 5000;

export const MEMBERSHIP_SWEEP_BATCH_LIMIT = 200;

export const MEMBERSHIP_EVENT_DEBOUNCE_MS = 250;

// GAMING_COMMANDS.notifyGamesCreated announces a larger import in events of this size.
// Must match the `.max()` on `gaming.games.created` in contracts/schemas/events.ts - the
// shared schemas cannot import a module contract, so the value is stated twice.
export const GAMES_CREATED_EVENT_BATCH = 1000;

export const GAME_CATEGORY_MEMBERSHIP_QUEUE = queue('gaming.category.membership');

export const GameCategoryMembershipJobSchema = z.object({
  categoryId: UuidSchema,
  // The queue carries only the runs no admin asked for; an admin's runs are synchronous.
  trigger: GameCategoryMembershipTriggerSchema.exclude(['admin']),
});
export type GameCategoryMembershipJob = z.infer<typeof GameCategoryMembershipJobSchema>;

// Re-evaluates rule-mode categories in batches: the only trigger a most_played clause has as its
// rolling window moves, and the backstop for a lost event-driven enqueue or a game
// inserted without GAMING_COMMANDS.notifyGamesCreated - see docs/modules/gaming.md.
export const GAME_CATEGORY_MEMBERSHIP_SWEEP_QUEUE = queue('gaming.category.membership-sweep');

export const GameCategoryMembershipSweepJobSchema = z.object({});

export const MEMBERSHIP_SWEEP_CRON = '15 * * * *';

export const GameTagDetailSchema = GameTagSummarySchema.extend({
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type GameTagDetail = z.infer<typeof GameTagDetailSchema>;
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
  // No isUnavailable: the flag is vendor-set only, an admin must never be able to toggle it.
  isActive: z.boolean().optional(),
  metadata: z.unknown().nullable().optional(),
  categoryIds: z.array(UuidSchema).max(50).optional(),
  tagIds: z.array(UuidSchema).max(50).optional(),
});
export type UpdateGameInput = z.infer<typeof UpdateGameInputSchema>;

const BulkGameTargetFieldsSchema = z.object({
  providerIds: z.array(UuidSchema).max(50).optional(),
  gameIds: z.array(UuidSchema).max(500).optional(),
});

function hasBulkTarget(target: { providerIds?: string[]; gameIds?: string[] }) {
  return (target.providerIds?.length ?? 0) > 0 || (target.gameIds?.length ?? 0) > 0;
}

const bulkTargetRefinement = {
  message: 'Provide at least one non-empty providerIds or gameIds',
  path: ['gameIds'],
};

export const SetGamesActiveInputSchema = BulkGameTargetFieldsSchema.extend({
  isActive: z.boolean(),
}).refine(hasBulkTarget, bulkTargetRefinement);
export type SetGamesActiveInput = z.infer<typeof SetGamesActiveInputSchema>;

export const AddGameTagsInputSchema = BulkGameTargetFieldsSchema.extend({
  tagIds: z.array(UuidSchema).min(1).max(50),
}).refine(hasBulkTarget, bulkTargetRefinement);
export type AddGameTagsInput = z.infer<typeof AddGameTagsInputSchema>;

export const AddGameCategoriesInputSchema = BulkGameTargetFieldsSchema.extend({
  categoryIds: z.array(UuidSchema).min(1).max(50),
}).refine(hasBulkTarget, bulkTargetRefinement);
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
});
export type SetGamesActiveOutput = z.infer<typeof SetGamesActiveOutputSchema>;

export const gamingAdminContract = {
  listAdminProviders: oc
    .route({ method: 'GET', path: '/backoffice/gaming/providers' })
    .input(CatalogFilterSchema)
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
    .output(GameSchema),

  listAdminGames: oc
    .route({ method: 'GET', path: '/backoffice/gaming/games' })
    .input(ListAdminGamesInputSchema)
    .output(paginated(GameSchema)),

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

import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyCodeSchema,
  GameCategoryNameSchema,
  GameCategorySummaryWithTranslationsSchema,
  GameCategoryTranslationsSchema,
  GameProviderAggregatorMappingSchema,
  GameProviderSummarySchema,
  GameTypeSchema,
  IdInputSchema,
  MoneyAmountSchema,
  PageQuerySchema,
  QueryBooleanSchema,
  TimestampSchema,
  UuidSchema,
  createKebabSlugSchema,
  paginated,
} from '@openora/core/contracts';

export { GameTypeSchema } from '@openora/core/contracts';
export { GameProviderSummarySchema } from '@openora/core/contracts';
export { GameProviderAggregatorMappingSchema } from '@openora/core/contracts';
export { GameCategorySummarySchema } from '@openora/core/contracts';
export { GameCategorySummaryWithTranslationsSchema } from '@openora/core/contracts';
export { GameCategoryTranslationsSchema } from '@openora/core/contracts';

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
  gameType: GameTypeSchema,
  thumbnailUrl: z.string().nullable(),
  isActive: z.boolean(),
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
    .output(z.array(GameProviderSummarySchema)),

  getProviderBySlug: oc
    .route({ method: 'GET', path: '/gaming/providers/{slug}' })
    .input(z.object({ slug: CatalogSlugSchema }))
    .output(GameProviderSummarySchema),

  listCategories: oc
    .route({ method: 'GET', path: '/gaming/categories' })
    .output(z.array(GameCategorySummaryWithTranslationsSchema)),

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
});
export type ListAdminGamesInput = z.infer<typeof ListAdminGamesInputSchema>;

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
});
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInputSchema>;

export const UpdateGameInputSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(256).optional(),
  slug: CatalogSlugSchema.optional(),
  providerId: UuidSchema.optional(),
  aggregator: z.string().trim().min(1).max(64).optional(),
  thumbnailUrl: z.string().trim().min(1).max(512).nullable().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().nullable().optional(),
  categoryIds: z.array(UuidSchema).max(50).optional(),
});
export type UpdateGameInput = z.infer<typeof UpdateGameInputSchema>;

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

  updateGame: oc
    .route({ method: 'PATCH', path: '/backoffice/gaming/games/{id}' })
    .input(UpdateGameInputSchema)
    .output(GameSchema),

  listAdminGames: oc
    .route({ method: 'GET', path: '/backoffice/gaming/games' })
    .input(ListAdminGamesInputSchema)
    .output(paginated(GameSchema)),
};

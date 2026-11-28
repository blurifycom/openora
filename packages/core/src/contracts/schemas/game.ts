import * as z from 'zod';
import { createBoundedJsonParamsSchema } from './bounded-json-params.js';
import { UuidSchema } from './common.js';
import { LanguageTagSchema } from './identity.js';

export const GAME_TYPES = ['original', 'casino', 'sportsbook'] as const;
export const GameTypeSchema = z.enum(GAME_TYPES);
export type GameType = z.infer<typeof GameTypeSchema>;

export const GAME_REVIEW_STATUSES = ['pending', 'auto_approved', 'approved', 'declined'] as const;
export const GameReviewStatusSchema = z.enum(GAME_REVIEW_STATUSES);
export type GameReviewStatus = z.infer<typeof GameReviewStatusSchema>;

export const GAME_REVIEW_DECISIONS = ['approve', 'decline'] as const;
export const GameReviewDecisionSchema = z.enum(GAME_REVIEW_DECISIONS);
export type GameReviewDecision = z.infer<typeof GameReviewDecisionSchema>;

export function initialGameReviewState(autoApprove: boolean, now: Date) {
  return autoApprove
    ? { isActive: true, reviewStatus: 'auto_approved' as const, reviewedAt: now }
    : { isActive: false, reviewStatus: 'pending' as const, reviewedAt: null };
}

export const GameProviderSummarySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  logoUrl: z.string().nullable(),
  customLogoUrl: z.string().nullable(),
});
export type GameProviderSummary = z.infer<typeof GameProviderSummarySchema>;

export const GameProviderAggregatorMappingSchema = z.object({
  aggregator: z.string().trim().min(1).max(64),
  vendorId: z.string().trim().min(1).max(128),
});
export type GameProviderAggregatorMapping = z.infer<typeof GameProviderAggregatorMappingSchema>;

export const GameBulkIdsSchema = z.object({
  gameIds: z.array(UuidSchema),
  providerIds: z.array(UuidSchema),
});
export type GameBulkIds = z.infer<typeof GameBulkIdsSchema>;

export const GAME_BULK_CAP = 5000;

export class GameBulkTooManyGamesError extends Error {
  readonly data = { reason: 'too_many_games' };

  constructor(matchedCount: number, cap: number) {
    super(`bulk action matched ${matchedCount} games, exceeding the ${cap}-game cap`);
    this.name = 'GameBulkTooManyGamesError';
  }
}

export const GameBulkTargetFieldsSchema = z.object({
  providerIds: z.array(UuidSchema).max(50).optional(),
  gameIds: z.array(UuidSchema).max(500).optional(),
});

export function hasGameBulkTarget(target: { providerIds?: string[]; gameIds?: string[] }) {
  return (target.providerIds?.length ?? 0) > 0 || (target.gameIds?.length ?? 0) > 0;
}

export const gameBulkTargetRefinement = {
  message: 'Provide at least one non-empty providerIds or gameIds',
  path: ['gameIds'],
};

const GameAddedLinkBaseSchema = z.object({ gameId: UuidSchema });

export const GameAddedTagLinksSchema = z.array(
  GameAddedLinkBaseSchema.extend({ tagIds: z.array(UuidSchema) }),
);
export type GameAddedTagLinks = z.infer<typeof GameAddedTagLinksSchema>;

export const GameAddedCategoryLinksSchema = z.array(
  GameAddedLinkBaseSchema.extend({ categoryIds: z.array(UuidSchema) }),
);
export type GameAddedCategoryLinks = z.infer<typeof GameAddedCategoryLinksSchema>;

export const GameCategoryNameSchema = z.string().trim().min(1).max(128);
export const GameCategoryTranslationSchema = z
  .object({
    name: GameCategoryNameSchema,
  })
  .strict();
export const GameCategoryTranslationsSchema = z.record(
  LanguageTagSchema,
  GameCategoryTranslationSchema,
);
export type GameCategoryTranslations = z.infer<typeof GameCategoryTranslationsSchema>;

export const GAME_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const GameSortDirectionSchema = z.enum(GAME_SORT_DIRECTIONS);
export type GameSortDirection = z.infer<typeof GameSortDirectionSchema>;

export const GAME_SORT_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const GameSortKeySchema = z.string().trim().min(1).max(64).regex(GAME_SORT_KEY_PATTERN);
export type GameSortKey = z.infer<typeof GameSortKeySchema>;

export const GAME_SORT_PARAMS_MAX_BYTES = 4096;

export const GameSortParamsSchema = createBoundedJsonParamsSchema({
  maxBytes: GAME_SORT_PARAMS_MAX_BYTES,
  label: 'Sort params',
});
export type GameSortParams = z.infer<typeof GameSortParamsSchema>;

export const GAME_CATEGORY_MEMBERSHIP_MODES = ['manual', 'rule'] as const;
export const GameCategoryMembershipModeSchema = z.enum(GAME_CATEGORY_MEMBERSHIP_MODES);
export type GameCategoryMembershipMode = z.infer<typeof GameCategoryMembershipModeSchema>;

export const GAME_CATEGORY_MEMBERSHIP_TRIGGERS = ['admin', 'event', 'schedule'] as const;
export const GameCategoryMembershipTriggerSchema = z.enum(GAME_CATEGORY_MEMBERSHIP_TRIGGERS);
export type GameCategoryMembershipTrigger = z.infer<typeof GameCategoryMembershipTriggerSchema>;

export const GAME_CATEGORY_GAME_SOURCES = ['manual', 'rule'] as const;

export const GameCategoryRuleKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(GAME_SORT_KEY_PATTERN);
export type GameCategoryRuleKey = z.infer<typeof GameCategoryRuleKeySchema>;

export const GAME_CATEGORY_RULE_CLAUSES_MAX = 10;

export const GAME_CATEGORY_RULE_PARAMS_MAX_BYTES = 4096;

export const GameCategoryRuleParamsSchema = createBoundedJsonParamsSchema({
  maxBytes: GAME_CATEGORY_RULE_PARAMS_MAX_BYTES,
  label: 'Rule params',
});

export const GameCategoryRuleClauseSchema = z
  .object({
    key: GameCategoryRuleKeySchema,
    params: GameCategoryRuleParamsSchema.default({}),
  })
  .strict();
export type GameCategoryRuleClause = z.infer<typeof GameCategoryRuleClauseSchema>;

export const GameCategoryRuleSchema = z
  .array(GameCategoryRuleClauseSchema)
  .min(1)
  .max(GAME_CATEGORY_RULE_CLAUSES_MAX);
export type GameCategoryRule = z.infer<typeof GameCategoryRuleSchema>;

export const GAME_CATEGORY_RULE_IDS_MAX = 50;
export const GAME_CATEGORY_RULE_MOST_PLAYED_MAX = 500;
export const GAME_CATEGORY_RULE_PERIOD_DAYS_MAX = 365;

const GameCategoryRuleIdsSchema = z
  .array(UuidSchema)
  .min(1)
  .max(GAME_CATEGORY_RULE_IDS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'ids must be unique' });

export const ProvidersRuleParamsSchema = z
  .object({ providerIds: GameCategoryRuleIdsSchema })
  .strict();
export type ProvidersRuleParams = z.infer<typeof ProvidersRuleParamsSchema>;

export const TagsRuleParamsSchema = z.object({ tagIds: GameCategoryRuleIdsSchema }).strict();
export type TagsRuleParams = z.infer<typeof TagsRuleParamsSchema>;

export const MostPlayedRuleParamsSchema = z
  .object({
    periodDays: z.number().int().min(1).max(GAME_CATEGORY_RULE_PERIOD_DAYS_MAX),
    limit: z.number().int().min(1).max(GAME_CATEGORY_RULE_MOST_PLAYED_MAX),
  })
  .strict();
export type MostPlayedRuleParams = z.infer<typeof MostPlayedRuleParamsSchema>;

export const GameCategorySummarySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  sortOrder: z.number(),
});
export type GameCategorySummary = z.infer<typeof GameCategorySummarySchema>;

export const GameCategorySummaryWithTranslationsSchema = GameCategorySummarySchema.extend({
  translations: GameCategoryTranslationsSchema.default({}),
});
export type GameCategorySummaryWithTranslations = z.infer<
  typeof GameCategorySummaryWithTranslationsSchema
>;

export const GAME_TAG_TYPES = ['system', 'custom'] as const;
export const GameTagTypeSchema = z.enum(GAME_TAG_TYPES);
export type GameTagType = z.infer<typeof GameTagTypeSchema>;

export const GAME_TAG_VISIBILITIES = ['visible', 'invisible'] as const;
export const GameTagVisibilitySchema = z.enum(GAME_TAG_VISIBILITIES);
export type GameTagVisibility = z.infer<typeof GameTagVisibilitySchema>;

export const GAME_TAG_METADATA_MAX_BYTES = 4096;

export const GameTagMetadataSchema = z
  .record(z.string().min(1).max(64), z.json())
  .refine(
    (metadata) =>
      new TextEncoder().encode(JSON.stringify(metadata)).length <= GAME_TAG_METADATA_MAX_BYTES,
    { message: `Metadata must serialize to at most ${GAME_TAG_METADATA_MAX_BYTES} bytes` },
  );
export type GameTagMetadata = z.infer<typeof GameTagMetadataSchema>;

export const GameTagSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  type: GameTagTypeSchema,
  visibility: GameTagVisibilitySchema,
  metadata: GameTagMetadataSchema.nullable(),
});
export type GameTagSummary = z.infer<typeof GameTagSummarySchema>;
export const GameTagSnapshotSchema = GameTagSummarySchema.omit({ id: true });

import * as z from 'zod';
import { createBoundedJsonParamsSchema } from './bounded-json-params.js';
import { UuidSchema } from './common.js';
import { LanguageSchema } from './identity.js';

export const GAME_TYPES = ['original', 'casino', 'sportsbook'] as const;
export const GameTypeSchema = z.enum(GAME_TYPES);
export type GameType = z.infer<typeof GameTypeSchema>;

export const GameProviderSummarySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  logoUrl: z.string().nullable(),
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
// Keyed by BCP 47 language tag, the same value a client reads from `user.language`: a
// country is not a language (BE, CH and CA each need several). The regex rejects the
// empty or malformed keys the bare length bound in LanguageSchema would let through.
export const GameCategoryTranslationsSchema = z.record(
  LanguageSchema.regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8})*$/),
  GameCategoryTranslationSchema,
);
export type GameCategoryTranslations = z.infer<typeof GameCategoryTranslationsSchema>;

export const GAME_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const GameSortDirectionSchema = z.enum(GAME_SORT_DIRECTIONS);
export type GameSortDirection = z.infer<typeof GameSortDirectionSchema>;

// A sort key names an entry in the operator-extensible GAME_SORT_CATALOG (built-ins:
// 'manual', 'name') - not a fixed enum, so it is a validated slug shape, not z.enum.
export const GAME_SORT_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const GameSortKeySchema = z.string().trim().min(1).max(64).regex(GAME_SORT_KEY_PATTERN);
export type GameSortKey = z.infer<typeof GameSortKeySchema>;

export const GAME_SORT_PARAMS_MAX_BYTES = 4096;

// Opaque to core: each sort definition's own paramsSchema gives it meaning. It is stored as
// jsonb and rides on every category event and audit row, hence JSON-only and byte-capped.
export const GameSortParamsSchema = createBoundedJsonParamsSchema({
  maxBytes: GAME_SORT_PARAMS_MAX_BYTES,
  label: 'Sort params',
});
export type GameSortParams = z.infer<typeof GameSortParamsSchema>;

export const GAME_CATEGORY_MEMBERSHIP_MODES = ['manual', 'rule'] as const;
export const GameCategoryMembershipModeSchema = z.enum(GAME_CATEGORY_MEMBERSHIP_MODES);
export type GameCategoryMembershipMode = z.infer<typeof GameCategoryMembershipModeSchema>;

// What started a membership evaluation: an admin (on demand, or after a create or
// update), a catalogue event, or the periodic sweep.
export const GAME_CATEGORY_MEMBERSHIP_TRIGGERS = ['admin', 'event', 'schedule'] as const;
export const GameCategoryMembershipTriggerSchema = z.enum(GAME_CATEGORY_MEMBERSHIP_TRIGGERS);
export type GameCategoryMembershipTrigger = z.infer<typeof GameCategoryMembershipTriggerSchema>;

// Who wrote a game_category_game row: an admin, or the rule evaluator.
export const GAME_CATEGORY_GAME_SOURCES = ['manual', 'rule'] as const;

// A rule key names an entry in the operator-extensible GAME_CATEGORY_RULE_CATALOG
// (built-ins: 'providers', 'tags', 'most_played') - not a fixed enum, so it is a validated
// slug shape like GameSortKeySchema, not z.enum.
export const GameCategoryRuleKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(GAME_SORT_KEY_PATTERN);
export type GameCategoryRuleKey = z.infer<typeof GameCategoryRuleKeySchema>;

export const GAME_CATEGORY_RULE_CLAUSES_MAX = 10;

export const GAME_CATEGORY_RULE_PARAMS_MAX_BYTES = 4096;

// Opaque to core, like GameSortParamsSchema: each rule definition's own paramsSchema gives
// it meaning, checked when the rule is saved - the catalog is bound at runtime. Stored as
// jsonb and carried on category events and audit rows, hence JSON-only and byte-capped.
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

/**
 * How a rule-mode category is populated: an ordered pipeline of clauses. The first
 * clause matches over the whole catalogue and every later clause narrows what the one
 * before it left, so clauses AND together and a ranking clause ('most_played') belongs last.
 * The same key may appear twice - two 'tags' clauses require a game to carry both.
 */
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

// Params of the three built-in rule kinds. Public so a client can type the clauses it sends.
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

// Operator-owned display data (a badge colour, an icon key). Lobby routes return it to
// players on every visible tag, so it must never hold internal data. The byte cap keeps
// it small on every lobby response and event snapshot, however deeply it nests.
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

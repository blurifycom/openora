import * as z from 'zod';
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

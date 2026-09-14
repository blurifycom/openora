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

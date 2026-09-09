import * as z from 'zod';
import { UuidSchema } from './common.js';
import { CountryCodeSchema } from './igaming-config.js';

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

export const GameCategoryNameSchema = z.string().trim().min(1).max(128);
export const GameCategoryTranslationSchema = z
  .object({
    name: GameCategoryNameSchema,
  })
  .strict();
export const GameCategoryTranslationsSchema = z.record(
  CountryCodeSchema,
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

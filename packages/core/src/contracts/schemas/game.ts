import * as z from 'zod';
import { UuidSchema } from './common.js';

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

export const GameCategorySummarySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  sortOrder: z.number(),
});
export type GameCategorySummary = z.infer<typeof GameCategorySummarySchema>;

export const GAME_TAG_TYPES = ['system', 'custom'] as const;
export const GameTagTypeSchema = z.enum(GAME_TAG_TYPES);
export type GameTagType = z.infer<typeof GameTagTypeSchema>;

export const GAME_TAG_VISIBILITIES = ['visible', 'invisible'] as const;
export const GameTagVisibilitySchema = z.enum(GAME_TAG_VISIBILITIES);
export type GameTagVisibility = z.infer<typeof GameTagVisibilitySchema>;

const HexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/);

export const DEFAULT_GAME_TAG_BADGE_SETTINGS = {
  badgeColor: '#3377ff',
  textColor: '#ffffff',
} as const;

export const GameTagBadgeSettingsSchema = z.object({
  badgeColor: HexColorSchema.default(DEFAULT_GAME_TAG_BADGE_SETTINGS.badgeColor),
  textColor: HexColorSchema.default(DEFAULT_GAME_TAG_BADGE_SETTINGS.textColor),
});
export type GameTagBadgeSettings = z.infer<typeof GameTagBadgeSettingsSchema>;

export const GameTagSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  type: GameTagTypeSchema,
  visibility: GameTagVisibilitySchema,
  badgeSettings: GameTagBadgeSettingsSchema,
});
export type GameTagSummary = z.infer<typeof GameTagSummarySchema>;
export const GameTagSnapshotSchema = GameTagSummarySchema.omit({ id: true });

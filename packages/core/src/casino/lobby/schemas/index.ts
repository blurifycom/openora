import * as z from 'zod';
import { UuidSchema } from '@blurifycom/core/contracts';

export const GameSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  provider: z.string(),
  category: z.string(),
  thumbnailUrl: z.string().nullable(),
});

export const LobbyCategorySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  sortOrder: z.number(),
  gameCount: z.number(),
});

export const LobbyCategoryDetailSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  games: z.array(GameSummarySchema),
});

export const FeaturedSlotSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  gameId: UuidSchema,
  gameName: z.string(),
  thumbnailUrl: z.string().nullable(),
  placement: z.string(),
  sortOrder: z.number(),
});

export type GameSummary = z.infer<typeof GameSummarySchema>;
export type LobbyCategory = z.infer<typeof LobbyCategorySchema>;
export type LobbyCategoryDetail = z.infer<typeof LobbyCategoryDetailSchema>;
export type FeaturedSlot = z.infer<typeof FeaturedSlotSchema>;

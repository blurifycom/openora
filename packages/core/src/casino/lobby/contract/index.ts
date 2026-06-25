import { oc } from '@orpc/contract';
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

export const lobbyContract = {
  listCategories: oc
    .route({ method: 'GET', path: '/lobby/categories' })
    .output(z.array(LobbyCategorySchema)),

  getCategoryBySlug: oc
    .route({ method: 'GET', path: '/lobby/categories/{slug}' })
    .input(z.object({ slug: z.string() }))
    .output(LobbyCategoryDetailSchema),

  getFeatured: oc
    .route({ method: 'GET', path: '/lobby/featured' })
    .output(z.array(FeaturedSlotSchema)),

  search: oc
    .route({ method: 'GET', path: '/lobby/search' })
    .input(z.object({ q: z.string() }))
    .output(z.array(GameSummarySchema)),
};

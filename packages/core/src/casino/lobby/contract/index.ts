import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  LobbyLayoutSectionSnapshotSchema,
  LobbyLayoutSnapshotSchema,
  LobbySectionConfigSchema,
  LobbySectionDataSchema,
  LobbySectionTypeSchema,
  TimestampSchema,
  UuidSchema,
} from '@openora/core/contracts';

export const LOBBY_SECTION_COUNT_MAX = 20;

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

export const LobbyAdminSectionSchema = LobbyLayoutSectionSnapshotSchema.extend({
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type LobbyAdminSection = z.infer<typeof LobbyAdminSectionSchema>;

export const LobbyAdminLayoutSchema = LobbyLayoutSnapshotSchema.extend({
  sections: z.array(LobbyAdminSectionSchema).max(LOBBY_SECTION_COUNT_MAX),
});
export type LobbyAdminLayout = z.infer<typeof LobbyAdminLayoutSchema>;

export const LobbySectionSaveInputSchema = z
  .object({
    id: UuidSchema.optional(),
    type: LobbySectionTypeSchema,
    config: LobbySectionConfigSchema,
    isEnabled: z.boolean().default(true),
  })
  .strict();
export type LobbySectionSaveInput = z.infer<typeof LobbySectionSaveInputSchema>;

export const ReplaceLobbyLayoutInputSchema = z
  .object({
    version: z.number().int().min(0),
    sections: z.array(LobbySectionSaveInputSchema).max(LOBBY_SECTION_COUNT_MAX),
  })
  .describe('Complete lobby layout replacement; omitted existing sections are deleted.');
export type ReplaceLobbyLayoutInput = z.infer<typeof ReplaceLobbyLayoutInputSchema>;

export const LobbyResolvedSectionSchema = z.object({
  id: UuidSchema,
  type: LobbySectionTypeSchema,
  data: LobbySectionDataSchema,
});
export type LobbyResolvedSection = z.infer<typeof LobbyResolvedSectionSchema>;

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

  getLayout: oc
    .route({ method: 'GET', path: '/lobby/layout' })
    .output(z.array(LobbyResolvedSectionSchema)),

  getAdminLayout: oc
    .route({ method: 'GET', path: '/backoffice/lobby/layout' })
    .output(LobbyAdminLayoutSchema),

  replaceLayout: oc
    .route({ method: 'PUT', path: '/backoffice/lobby/layout' })
    .input(ReplaceLobbyLayoutInputSchema)
    .output(LobbyAdminLayoutSchema),
};

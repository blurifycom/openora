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
  getLayout: oc
    .route({ method: 'GET', path: '/lobby/layout' })
    .output(z.array(LobbyResolvedSectionSchema)),
};

export const lobbyAdminContract = {
  getAdminLayout: oc
    .route({ method: 'GET', path: '/backoffice/lobby/layout' })
    .output(LobbyAdminLayoutSchema),

  replaceLayout: oc
    .route({ method: 'PUT', path: '/backoffice/lobby/layout' })
    .input(ReplaceLobbyLayoutInputSchema)
    .output(LobbyAdminLayoutSchema),
};

import * as z from 'zod';
import { UuidSchema } from './common.js';

export const LobbySectionTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type LobbySectionType = z.infer<typeof LobbySectionTypeSchema>;

export const LobbySectionConfigSchema = z.record(z.string(), z.json());
export type LobbySectionConfig = z.infer<typeof LobbySectionConfigSchema>;
export const LobbySectionDataSchema = z.json();
export type LobbySectionData = z.infer<typeof LobbySectionDataSchema>;

export const LobbyLayoutSectionSnapshotSchema = z.object({
  id: UuidSchema,
  type: LobbySectionTypeSchema,
  config: LobbySectionConfigSchema,
  sortOrder: z.number().int().min(0),
  isEnabled: z.boolean(),
});
export type LobbyLayoutSectionSnapshot = z.infer<typeof LobbyLayoutSectionSnapshotSchema>;

export const LobbyLayoutSnapshotSchema = z.object({
  version: z.number().int().min(0),
  sections: z.array(LobbyLayoutSectionSnapshotSchema),
});
export type LobbyLayoutSnapshot = z.infer<typeof LobbyLayoutSnapshotSchema>;

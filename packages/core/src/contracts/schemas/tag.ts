import z from 'zod';
import { UuidSchema } from './common.js';

export const tagAssignRemoveSource = ['scheduled', 'manual'] as const;
export const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;

const tagAssignRemoveSourceSchema = z.enum(tagAssignRemoveSource);
export type TagAssignSource = z.infer<typeof tagAssignRemoveSourceSchema>;

export const tagSchema = z.object({
  id: UuidSchema,
  key: z.string().trim().min(1),
  isSticky: z.boolean().default(false),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Tag = z.infer<typeof tagSchema>;

export const createTagSchema = tagSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = tagSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const deleteTagSchema = tagSchema.pick({ key: true });
export type DeleteTagInput = z.infer<typeof deleteTagSchema>;

export const playerTagSchema = z.object({
  id: UuidSchema,
  playerId: UuidSchema,
  tagId: UuidSchema,
  assignReason: z.string(),
  assignActor: tagAssignRemoveSourceSchema,
  assignActorUserId: UuidSchema,
  removedAt: z.coerce.date().nullable(),
  removalReason: z.string().nullable(),
  removalActor: tagAssignRemoveSourceSchema.nullable(),
  removalActorUserId: UuidSchema.nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PlayerTag = z.infer<typeof playerTagSchema>;

export const assignPlayerTagSchema = playerTagSchema
  .pick({ playerId: true, assignActor: true, assignActorUserId: true })
  .extend({
    tagKey: UuidSchema,
    assignReason: z.string().min(5),
  });
export type AssignPlayerTagInput = z.infer<typeof assignPlayerTagSchema>;

export const removePlayerTagSchema = playerTagSchema.pick({ playerId: true }).extend({
  tagKey: UuidSchema,
  removalReason: z.string().min(5),
  removalActor: tagAssignRemoveSourceSchema,
  removalActorUserId: UuidSchema,
});
export type RemovePlayerTagInput = z.infer<typeof removePlayerTagSchema>;

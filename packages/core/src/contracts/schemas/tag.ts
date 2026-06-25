import z from 'zod';

export const tagAssignRemoveSource = ['scheduled', 'manual'] as const;
export const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;

const tagAssignRemoveSourceSchema = z.enum(tagAssignRemoveSource);
export type TagAssignSource = z.infer<typeof tagAssignRemoveSourceSchema>;

export const tagSchema = z.object({
  id: z.uuid(),
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  color: z.string().regex(hexColorRegex),
  description: z.string().nullable().optional(),
  isSticky: z.boolean().default(false),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Tag = z.infer<typeof tagSchema>;

export const createTagSchema = z.object({
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  color: z.string().regex(hexColorRegex),
  description: z.string().nullable().optional(),
  isSticky: z.boolean().optional(),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = z.object({
  key: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  color: z.string().regex(hexColorRegex).optional(),
  description: z.string().nullable().optional(),
  isSticky: z.boolean().optional(),
});
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const deleteTagSchema = z.object({
  key: z.string().trim().min(1),
});
export type DeleteTagInput = z.infer<typeof deleteTagSchema>;

export const playerTagSchema = z.object({
  id: z.uuid(),
  playerId: z.uuid(),
  tagId: z.uuid(),
  assignReason: z.string(),
  assignActor: tagAssignRemoveSourceSchema,
  assignActorUserId: z.uuid(),
  removedAt: z.coerce.date().nullable(),
  removalReason: z.string().nullable(),
  removalActor: tagAssignRemoveSourceSchema.nullable(),
  removalActorUserId: z.uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PlayerTag = z.infer<typeof playerTagSchema>;

export const assignPlayerTagSchema = z.object({
  playerId: z.uuid(),
  tagKey: z.uuid(),
  assignReason: z.string().min(5),
  assignActor: tagAssignRemoveSourceSchema,
  assignActorUserId: z.uuid(),
});
export type AssignPlayerTagInput = z.infer<typeof assignPlayerTagSchema>;

export const removePlayerTagSchema = z.object({
  playerId: z.uuid(),
  tagKey: z.uuid(),
  removalReason: z.string().min(5),
  removalActor: tagAssignRemoveSourceSchema,
  removalActorUserId: z.uuid(),
});
export type RemovePlayerTagInput = z.infer<typeof removePlayerTagSchema>;

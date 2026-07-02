import { oc } from '@orpc/contract';
import {
  UuidSchema,
  TagKeySchema,
  createTagSchema,
  deleteTagSchema,
  playerTagSchema,
  tagSchema,
  tagAssignRemoveSource,
} from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';
import z from 'zod';

export {
  createTagSchema,
  deleteTagSchema,
  tagSchema,
  playerTagSchema,
  type Tag,
  type PlayerTag,
} from '@blurifycom/core/contracts';

const tagAssignRemoveSourceSchema = z.enum(tagAssignRemoveSource);

export const PlayerTagWithTagSchema = playerTagSchema.extend({
  tag: tagSchema.pick({ key: true }),
});
export type PlayerTagWithTag = z.infer<typeof PlayerTagWithTagSchema>;

const AssignPlayerTagInputSchema = z.object({
  playerId: UuidSchema,
  tagKey: TagKeySchema,
  assignReason: z.string().min(5),
  assignActor: tagAssignRemoveSourceSchema,
});

const RemovePlayerTagInputSchema = z.object({
  playerId: UuidSchema,
  tagKey: TagKeySchema,
  removalReason: z.string().min(5),
  removalActor: tagAssignRemoveSourceSchema,
});

export const tagContract = {
  createTag: oc.route({ method: 'POST', path: '/tag' }).input(createTagSchema).output(tagSchema),

  deleteTag: oc
    .route({ method: 'DELETE', path: '/tag/{key}' })
    .input(deleteTagSchema)
    .output(z.boolean()),

  listPlayerTags: oc
    .route({ method: 'GET', path: '/player/{playerId}/player-tag' })
    .input(PageQuerySchema.extend({ playerId: UuidSchema }))
    .output(paginated(PlayerTagWithTagSchema)),

  assignPlayerTag: oc
    .route({ method: 'POST', path: '/player/{playerId}/player-tag' })
    .input(AssignPlayerTagInputSchema)
    .output(PlayerTagWithTagSchema),

  removePlayerTag: oc
    .route({ method: 'DELETE', path: '/player/{playerId}/player-tag/{tagKey}' })
    .input(RemovePlayerTagInputSchema)
    .output(PlayerTagWithTagSchema),
};

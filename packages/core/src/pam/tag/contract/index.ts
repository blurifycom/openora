import { oc } from '@orpc/contract';
import {
  UuidSchema,
  createTagSchema,
  deleteTagSchema,
  playerTagSchema,
  tagSchema,
  tagRuleSchema,
  upsertTagRuleSchema,
  assignPlayerTagSchema,
  removePlayerTagSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';
import z from 'zod';
import { HighRiskAssignMetadataSchema } from './player-tag-assign-metadata.js';

export * from './player-tag-assign-metadata.js';

export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export const PLAYER_TAG_SORT_BY_VALUES = ['createdAt', 'assignActor'] as const;
export const PlayerTagSortBySchema = z.enum(PLAYER_TAG_SORT_BY_VALUES).default('createdAt');
export type PlayerTagSortBy = z.infer<typeof PlayerTagSortBySchema>;

export const PlayerTagWithTagSchema = playerTagSchema.extend({
  tag: tagSchema.pick({ key: true }),
  assignMetadata: HighRiskAssignMetadataSchema.nullable(),
});
export type PlayerTagWithTag = z.infer<typeof PlayerTagWithTagSchema>;

const AssignPlayerTagInputSchema = assignPlayerTagSchema.omit({ assignActorUserId: true });
const RemovePlayerTagInputSchema = removePlayerTagSchema.omit({ removalActorUserId: true });

export const tagContract = {
  createTag: oc.route({ method: 'POST', path: '/tag' }).input(createTagSchema).output(tagSchema),

  deleteTag: oc
    .route({ method: 'DELETE', path: '/tag/{key}' })
    .input(deleteTagSchema)
    .output(z.boolean()),

  listPlayerTags: oc
    .route({ method: 'GET', path: '/player/{playerId}/player-tag' })
    .input(
      PageQuerySchema.extend({
        playerId: UuidSchema,
        sortBy: PlayerTagSortBySchema.optional(),
        sortOrder: SortOrderSchema.default('desc').optional(),
      }),
    )
    .output(paginated(PlayerTagWithTagSchema)),

  assignPlayerTag: oc
    .route({ method: 'POST', path: '/player/{playerId}/player-tag' })
    .input(AssignPlayerTagInputSchema)
    .output(PlayerTagWithTagSchema),

  removePlayerTag: oc
    .route({ method: 'DELETE', path: '/player/{playerId}/player-tag/{tagKey}' })
    .input(RemovePlayerTagInputSchema)
    .output(PlayerTagWithTagSchema),

  listAssignableTags: oc
    .route({ method: 'GET', path: '/player/{playerId}/assignable-tags' })
    .input(z.object({ playerId: UuidSchema }))
    .output(z.array(tagSchema)),

  listTagRules: oc
    .route({ method: 'GET', path: '/tag-rule' })
    .input(z.object({}))
    .output(z.array(tagRuleSchema)),

  upsertTagRule: oc
    .route({ method: 'PUT', path: '/tag-rule/{tagKey}' })
    .input(upsertTagRuleSchema)
    .output(tagRuleSchema),
};

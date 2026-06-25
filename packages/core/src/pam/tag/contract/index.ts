import { oc } from '@orpc/contract';
import {
  assignPlayerTagSchema,
  createTagSchema,
  deleteTagSchema,
  PlayerSchema,
  playerTagSchema,
  removePlayerTagSchema,
  tagSchema,
  UpdatePlayerProfileInputSchema,
} from '@blurifycom/core/contracts';
import z from 'zod';

export {
  createTagSchema,
  deleteTagSchema,
  assignPlayerTagSchema,
  removePlayerTagSchema,
  tagSchema,
  playerTagSchema,
  type Tag,
  type PlayerTag,
} from '@blurifycom/core/contracts';

export const tagContract = {
  createTag: oc
    .route({
      method: 'POST',
      path: '/tag',
    })
    .input(createTagSchema)
    .output(tagSchema),

  deleteTag: oc
    .route({
      method: 'DELETE',
      path: '/tag/{key}',
    })
    .input(deleteTagSchema)
    .output(z.boolean()),

  assignPlayerTag: oc
    .route({
      method: 'POST',
      path: '/player-tag/assign',
    })
    .input(assignPlayerTagSchema)
    .output(playerTagSchema),

  removePlayerTag: oc
    .route({
      method: 'PUT',
      path: '/player-tag/remove',
    })
    .input(removePlayerTagSchema)
    .output(playerTagSchema),
};

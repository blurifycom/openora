import { implement } from '@orpc/server';
import { getUserId, type OssContext } from '@blurifycom/core/server';
import { tagContract } from '../contract/index.js';
import { TagService } from '../service/tag.service.js';

export function createTagRouter(tag: TagService) {
  const os = implement(tagContract).$context<OssContext>();

  return os.router({
    createTag: os.createTag.handler(({ input }) => tag.createTag(input)),

    deleteTag: os.deleteTag.handler(({ input }) => tag.deleteTag(input)),

    listPlayerTags: os.listPlayerTags.handler(({ input }) =>
      tag.listPlayerTags(input.playerId, input.page, input.limit),
    ),

    assignPlayerTag: os.assignPlayerTag.handler(({ context, input }) =>
      tag.assignPlayerTag({ ...input, assignActorUserId: getUserId(context) }),
    ),

    removePlayerTag: os.removePlayerTag.handler(({ context, input }) =>
      tag.removePlayerTag({ ...input, removalActorUserId: getUserId(context) }),
    ),
  });
}

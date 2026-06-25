import { implement } from '@orpc/server';
import { getUserId, type OssContext } from '@blurifycom/core/server';
import { tagContract } from '../contract/index.js';
import { TagService } from '../service/tag.service.js';

export function createTagRouter(tag: TagService) {
  const os = implement(tagContract).$context<OssContext>();

  return os.router({
    createTag: os.createTag.handler(({ context, input }) =>
      tag.createTag(input, getUserId(context)),
    ),

    deleteTag: os.deleteTag.handler(({ context, input }) =>
      tag.deleteTag(input, getUserId(context)),
    ),

    assignPlayerTag: os.assignPlayerTag.handler(({ context, input }) =>
      tag.assignPlayerTag({ ...input, assignActorUserId: getUserId(context) }),
    ),

    removePlayerTag: os.removePlayerTag.handler(({ context, input }) =>
      tag.removePlayerTag({ ...input, removalActorUserId: getUserId(context) }),
    ),
  });
}

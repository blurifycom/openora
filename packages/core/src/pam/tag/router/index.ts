import { implement } from '@orpc/server';
import { getUserId, type AdminGuard, type OssContext } from '@openora/core/server';
import { tagContract } from '../contract/index.js';
import { TagService } from '../service/tag.service.js';
import { TagRuleService } from '../service/tag-rule.service.js';

export function createTagRouter(tag: TagService, rule: TagRuleService, adminGuard: AdminGuard) {
  const os = implement(tagContract).$context<OssContext>();

  return os.router({
    createTag: os.createTag.handler(({ input }) => tag.createTag(input)),

    deleteTag: os.deleteTag.handler(({ input }) => tag.deleteTag(input)),

    listPlayerTags: os.listPlayerTags.handler(({ input }) =>
      tag.listPlayerTags({
        playerId: input.playerId,
        page: input.page,
        limit: input.limit,
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
      }),
    ),

    assignPlayerTag: os.assignPlayerTag.handler(({ context, input }) =>
      tag.assignPlayerTag({ ...input, assignActorUserId: getUserId(context) }),
    ),

    removePlayerTag: os.removePlayerTag.handler(({ context, input }) =>
      tag.removePlayerTag({ ...input, removalActorUserId: getUserId(context) }),
    ),

    listAssignableTags: os.listAssignableTags.handler(({ input }) =>
      tag.listAssignableTags(input.playerId),
    ),

    listTagRules: os.listTagRules.handler(async ({ context }) => {
      await adminGuard.assert(context, 'tag-rule', 'view');
      return rule.listTagRules();
    }),

    upsertTagRule: os.upsertTagRule.handler(async ({ context, input }) => {
      await adminGuard.assert(context, 'tag-rule', 'update');
      return rule.upsertTagRule(input, getUserId(context));
    }),
  });
}

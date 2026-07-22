import { implement } from '@orpc/server';
import {
  getUserId,
  extractClientMeta,
  type AdminGuard,
  type OssContext,
} from '@openora/core/server';
import { tagContract } from '../contract/index.js';
import { TagService } from '../service/tag.service.js';
import { TagRuleService } from '../service/tag-rule.service.js';

export function createTagRouter(tag: TagService, rule: TagRuleService, adminGuard: AdminGuard) {
  const os = implement(tagContract).$context<OssContext>();

  return os.router({
    createTag: os.createTag.handler(({ input }) => tag.createTag(input)),

    deleteTag: os.deleteTag.handler(({ input }) => tag.deleteTag(input)),

    listPlayerTags: os.listPlayerTags.handler(({ input }) =>
      tag.listPlayerTags(input.playerId, input.page, input.limit),
    ),

    assignPlayerTag: os.assignPlayerTag.handler(({ context, input }) => {
      const meta = extractClientMeta(context.request.headers);
      return tag.assignPlayerTag({ ...input, assignActorUserId: getUserId(context) }, meta);
    }),

    removePlayerTag: os.removePlayerTag.handler(({ context, input }) => {
      const meta = extractClientMeta(context.request.headers);
      return tag.removePlayerTag({ ...input, removalActorUserId: getUserId(context) }, meta);
    }),

    listAssignableTags: os.listAssignableTags.handler(({ input }) =>
      tag.listAssignableTags(input.playerId),
    ),

    listTagRules: os.listTagRules.handler(async ({ context }) => {
      await adminGuard.assert(context, 'tag-rule', 'view');
      return rule.listTagRules();
    }),

    upsertTagRule: os.upsertTagRule.handler(async ({ context, input }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'tag-rule', 'update');
      return rule.upsertTagRule(input, userId, { ip, userAgent });
    }),
  });
}

import { implement } from '@orpc/server';
import { getUserId, mapErrors, type AdminGuard, type OssContext } from '@openora/core/server';
import { tagContract } from '../contract/index.js';
import {
  TagService,
  TagNotFoundError,
  TagAlreadyInUseError,
  TagAssignmentNotFoundError,
  TagKeyConflictError,
  TagInUseError,
} from '../service/tag.service.js';
import { TagRuleService, TagRuleNotFoundError } from '../service/tag-rule.service.js';

export function createTagRouter(tag: TagService, rule: TagRuleService, adminGuard: AdminGuard) {
  const os = implement(tagContract).$context<OssContext>();

  return os.router({
    createTag: os.createTag.handler(async ({ context, input }) => {
      await adminGuard.assert(context, 'tag', 'create');
      return mapErrors({ CONFLICT: TagKeyConflictError }, () =>
        tag.createTag(input, getUserId(context)),
      );
    }),

    deleteTag: os.deleteTag.handler(async ({ context, input }) => {
      await adminGuard.assert(context, 'tag', 'delete');
      return mapErrors({ NOT_FOUND: TagNotFoundError, CONFLICT: TagInUseError }, () =>
        tag.deleteTag(input, getUserId(context)),
      );
    }),

    listPlayerTags: os.listPlayerTags.handler(async ({ context, input }) => {
      await adminGuard.assert(context, 'tag', 'view');
      return tag.listPlayerTags(input.playerId, input.page, input.limit);
    }),

    assignPlayerTag: os.assignPlayerTag.handler(async ({ context, input }) => {
      await adminGuard.assert(context, 'tag', 'create');
      return mapErrors({ NOT_FOUND: TagNotFoundError, CONFLICT: TagAlreadyInUseError }, () =>
        tag.assignPlayerTag({ ...input, assignActorUserId: getUserId(context) }),
      );
    }),

    removePlayerTag: os.removePlayerTag.handler(async ({ context, input }) => {
      await adminGuard.assert(context, 'tag', 'delete');
      return mapErrors({ NOT_FOUND: [TagNotFoundError, TagAssignmentNotFoundError] }, () =>
        tag.removePlayerTag({ ...input, removalActorUserId: getUserId(context) }),
      );
    }),

    listAssignableTags: os.listAssignableTags.handler(async ({ context, input }) => {
      await adminGuard.assert(context, 'tag', 'view');
      return tag.listAssignableTags(input.playerId);
    }),

    listTagRules: os.listTagRules.handler(async ({ context }) => {
      await adminGuard.assert(context, 'tag-rule', 'view');
      return rule.listTagRules();
    }),

    upsertTagRule: os.upsertTagRule.handler(async ({ context, input }) => {
      await adminGuard.assert(context, 'tag-rule', 'update');
      return mapErrors({ NOT_FOUND: TagRuleNotFoundError }, () =>
        rule.upsertTagRule(input, getUserId(context)),
      );
    }),
  });
}

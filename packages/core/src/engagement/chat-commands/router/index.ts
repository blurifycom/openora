import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import { assertRateLimit, getUserId, type OssContext, type AdminGuard } from '@openora/core/server';
import {
  makeRateLimitKey,
  RATE_LIMIT_KEYS,
  type RateLimiterAdapter,
} from '@openora/core/contracts';
import { chatCommandsContract } from '../contract/index.js';
import { ChatCommandsService } from '../service/chat-commands.service.js';

const cc = populateContractRouterPaths({ chatCommands: chatCommandsContract }).chatCommands;

// A typed query reads usernames across every player, so it is throttled per viewer. An overlay
// serving its own mention route limits it under the same key to share this counter.
const MENTION_SEARCH_RATE_LIMIT = {
  limit: 30,
  windowMs: 10_000,
  onUnavailable: 'allow',
} as const;

export function createChatCommandsRouter(
  svc: ChatCommandsService,
  adminGuard: AdminGuard,
  limiter: RateLimiterAdapter,
) {
  const os = implement(cc).$context<OssContext>();

  return os.router({
    listCommands: os.listCommands.handler(() => svc.listCommands()),

    adminListCommands: os.adminListCommands.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'chat-command', 'view');
      return svc.adminListCommands(input);
    }),

    adminUpdateCommand: os.adminUpdateCommand.handler(async ({ input, context }) => {
      const { userId } = await adminGuard.assert(context, 'chat-command', 'update');
      return svc.adminUpdateCommand(input, userId);
    }),

    mentionSearch: os.mentionSearch.handler(async ({ input, context }) => {
      const viewerId = getUserId(context);
      await assertRateLimit(
        limiter,
        makeRateLimitKey(RATE_LIMIT_KEYS.CHAT_MENTION_SEARCH, viewerId),
        MENTION_SEARCH_RATE_LIMIT,
      );
      return svc.searchMentions({ ...input, viewerId });
    }),
  });
}

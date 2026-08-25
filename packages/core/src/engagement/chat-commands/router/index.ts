import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import { getUserId, type OssContext, type AdminGuard } from '@openora/core/server';
import { chatCommandsContract } from '../contract/index.js';
import { ChatCommandsService } from '../service/chat-commands.service.js';

const cc = populateContractRouterPaths({
  chatCommands: {
    listCommands: chatCommandsContract.listCommands,
    adminListCommands: chatCommandsContract.adminListCommands,
    adminUpdateCommand: chatCommandsContract.adminUpdateCommand,
    mentionSearch: chatCommandsContract.mentionSearch,
  },
}).chatCommands;

export function createChatCommandsRouter(svc: ChatCommandsService, adminGuard: AdminGuard) {
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

    mentionSearch: os.mentionSearch.handler(({ input, context }) => {
      const viewerId = getUserId(context);
      return svc.searchMentions({ ...input, viewerId });
    }),
  });
}

import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import { mapErrors, getUserId, AdminGuard, type OssContext } from '@openora/core/server';
import { chatCommandsContract } from '../contract/index.js';
import {
  ChatCommandsService,
  CommandDisabledError,
  ChatPlayerNotFoundError,
  InsufficientBalanceError,
  ExceedsLimitError,
  BelowMinimumError,
  NoOnlineUsersError,
  RainCreditError,
  GiftNotFoundError,
  GiftAlreadyClaimedError,
  GiftSelfClaimError,
} from '../service/chat-commands.service.js';

const cc = populateContractRouterPaths({ chatCommands: chatCommandsContract }).chatCommands;

export function createChatCommandsRouter(svc: ChatCommandsService, adminGuard: AdminGuard) {
  const os = implement(cc).$context<OssContext>();

  return os.router({
    listCommands: os.listCommands.handler(() => svc.listCommands()),

    execute: os.execute.handler(({ input, context }) => {
      const actorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [CommandDisabledError, ChatPlayerNotFoundError],
          CONFLICT: [
            InsufficientBalanceError,
            ExceedsLimitError,
            BelowMinimumError,
            NoOnlineUsersError,
            RainCreditError,
          ],
        },
        () => svc.executeCommand(input, actorId),
      );
    }),

    getGift: os.getGift.handler(({ input }) =>
      mapErrors({ NOT_FOUND: [GiftNotFoundError] }, () => svc.getGift(input.id)),
    ),

    claimGift: os.claimGift.handler(({ input, context }) => {
      const claimerId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [GiftNotFoundError],
          CONFLICT: [GiftAlreadyClaimedError, GiftSelfClaimError],
        },
        () => svc.claimGift(input.id, claimerId),
      );
    }),

    mentionSearch: os.mentionSearch.handler(({ input, context }) => {
      getUserId(context);
      return svc.searchMentions(input.q, input.limit);
    }),

    adminUpdateCommand: os.adminUpdateCommand.handler(async ({ input, context }) => {
      await adminGuard.assert(context);
      const actorId = getUserId(context);
      return svc.adminUpdateCommand(input, actorId);
    }),
  });
}

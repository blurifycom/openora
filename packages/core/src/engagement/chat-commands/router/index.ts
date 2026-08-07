import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import { mapErrors, getUserId, type OssContext } from '@openora/core/server';
import { chatCommandsContract } from '../contract/index.js';
import {
  ChatCommandsService,
  CommandDisabledError,
  InsufficientBalanceError,
  ExceedsLimitError,
  BelowMinimumError,
  NoOnlineUsersError,
  TooManyRecipientsError,
  RainCreditError,
  GiftNotFoundError,
  GiftAlreadyClaimedError,
  GiftSelfClaimError,
  ChatCommandIdempotencyKeyReuseError,
  ConcurrentCommandReplayError,
  ChatRoomNotMemberError,
} from '../service/chat-commands.service.js';

const cc = populateContractRouterPaths({ chatCommands: chatCommandsContract }).chatCommands;

export function createChatCommandsRouter(svc: ChatCommandsService) {
  const os = implement(cc).$context<OssContext>();

  return os.router({
    listCommands: os.listCommands.handler(() => svc.listCommands()),

    postGift: os.postGift.handler(({ input, context }) => {
      const actorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [CommandDisabledError],
          CONFLICT: [
            InsufficientBalanceError,
            ExceedsLimitError,
            BelowMinimumError,
            ChatCommandIdempotencyKeyReuseError,
            ConcurrentCommandReplayError,
          ],
          FORBIDDEN: [ChatRoomNotMemberError],
        },
        () => svc.postGift(input, actorId),
      );
    }),

    claimGift: os.claimGift.handler(({ input, context }) => {
      const claimerId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [GiftNotFoundError],
          FORBIDDEN: [ChatRoomNotMemberError],
          CONFLICT: [GiftAlreadyClaimedError, GiftSelfClaimError],
        },
        () => svc.claimGift(input.id, claimerId),
      );
    }),

    getGift: os.getGift.handler(({ input, context }) => {
      const viewerId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [GiftNotFoundError],
          FORBIDDEN: [ChatRoomNotMemberError],
        },
        () => svc.getGift(input.id, viewerId),
      );
    }),

    postRain: os.postRain.handler(({ input, context }) => {
      const actorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [CommandDisabledError],
          CONFLICT: [
            InsufficientBalanceError,
            ExceedsLimitError,
            BelowMinimumError,
            NoOnlineUsersError,
            TooManyRecipientsError,
            RainCreditError,
            ChatCommandIdempotencyKeyReuseError,
            ConcurrentCommandReplayError,
          ],
          FORBIDDEN: [ChatRoomNotMemberError],
        },
        () => svc.postRain(input, actorId),
      );
    }),

    mentionSearch: os.mentionSearch.handler(({ input, context }) => {
      const viewerId = getUserId(context);
      return svc.searchMentions(input.q, input.limit, viewerId);
    }),
  });
}

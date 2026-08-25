import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import { mapErrors, getUserId, type OssContext, type AdminGuard } from '@openora/core/server';
import { chatCommandsContract } from '../contract/index.js';
import {
  BlockedRecipientError as TransferBlockedRecipientError,
  ChatCommandIdempotencyKeyReuseError as TransferIdempotencyKeyReuseError,
  ChatCommandTransfersService,
  ChatPlayerNotFoundError as TransferChatPlayerNotFoundError,
  ChatRoomNotMemberError as TransferChatRoomNotMemberError,
  CommandDisabledError as TransferCommandDisabledError,
  ConcurrentCommandReplayError as TransferConcurrentReplayError,
  DonateSelfError,
  ExceedsLimitError as TransferExceedsLimitError,
  BelowMinimumError as TransferBelowMinimumError,
  InsufficientBalanceError as TransferInsufficientBalanceError,
  NoOnlineUsersError as TransferNoOnlineUsersError,
  RainCreditError as TransferRainCreditError,
  TooManyRecipientsError as TransferTooManyRecipientsError,
  GiftAlreadyClaimedError,
  GiftCreditError,
  GiftNotFoundError,
  GiftSelfClaimError,
} from '../service/chat-command-transfers.service.js';
import { ChatCommandsService } from '../service/chat-commands.service.js';

const cc = populateContractRouterPaths({ chatCommands: chatCommandsContract }).chatCommands;

export function createChatCommandsRouter(
  svc: ChatCommandsService,
  transferService: ChatCommandTransfersService,
  adminGuard: AdminGuard,
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

    postGift: os.postGift.handler(({ input, context }) => {
      const actorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [TransferCommandDisabledError, TransferChatPlayerNotFoundError],
          CONFLICT: [
            TransferInsufficientBalanceError,
            TransferExceedsLimitError,
            TransferBelowMinimumError,
            TransferIdempotencyKeyReuseError,
            TransferConcurrentReplayError,
          ],
          FORBIDDEN: [TransferChatRoomNotMemberError],
        },
        () => svc.postGift(input, actorId),
      );
    }),

    claimGift: os.claimGift.handler(({ input, context }) => {
      const claimerId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [GiftNotFoundError],
          FORBIDDEN: [TransferChatRoomNotMemberError],
          CONFLICT: [
            GiftAlreadyClaimedError,
            GiftSelfClaimError,
            TransferBlockedRecipientError,
            GiftCreditError,
          ],
        },
        () => svc.claimGift(input.id, claimerId),
      );
    }),

    getGift: os.getGift.handler(({ input, context }) => {
      const viewerId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [GiftNotFoundError],
          FORBIDDEN: [TransferChatRoomNotMemberError],
        },
        () => svc.getGift(input.id, viewerId),
      );
    }),

    postRain: os.postRain.handler(({ input, context }) => {
      const actorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [TransferCommandDisabledError, TransferChatPlayerNotFoundError],
          CONFLICT: [
            TransferInsufficientBalanceError,
            TransferExceedsLimitError,
            TransferBelowMinimumError,
            TransferNoOnlineUsersError,
            TransferTooManyRecipientsError,
            TransferRainCreditError,
            TransferIdempotencyKeyReuseError,
            TransferConcurrentReplayError,
          ],
          FORBIDDEN: [TransferChatRoomNotMemberError],
        },
        () => svc.postRain(input, actorId),
      );
    }),

    sendDonate: os.sendDonate.handler(({ input, context }) => {
      const actorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [TransferCommandDisabledError, TransferChatPlayerNotFoundError],
          CONFLICT: [
            TransferInsufficientBalanceError,
            TransferExceedsLimitError,
            TransferBelowMinimumError,
            DonateSelfError,
            TransferBlockedRecipientError,
            TransferIdempotencyKeyReuseError,
            TransferConcurrentReplayError,
          ],
          FORBIDDEN: [TransferChatRoomNotMemberError],
        },
        () => transferService.sendDonate(input, actorId),
      );
    }),

    mentionSearch: os.mentionSearch.handler(({ input, context }) => {
      const viewerId = getUserId(context);
      return svc.searchMentions({ ...input, viewerId });
    }),
  });
}

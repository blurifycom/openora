import { implement } from '@orpc/server';
import { mapErrors, getUserId, type OssContext } from '@openora/core/server';
import { socialTransfersContract } from '../contract/index.js';
import {
  SocialTransfersService,
  CommandDisabledError,
  InsufficientBalanceError,
  ExceedsLimitError,
  BelowMinimumError,
  DonateSelfError,
  ChatPlayerNotFoundError,
  ChatCommandIdempotencyKeyReuseError,
  ConcurrentCommandReplayError,
  ChatRoomNotMemberError,
} from '../service/social-transfers.service.js';

export function createSocialTransfersRouter(svc: SocialTransfersService) {
  const os = implement(socialTransfersContract).$context<OssContext>();

  return os.router({
    sendDonate: os.sendDonate.handler(({ input, context }) => {
      const actorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: [CommandDisabledError, ChatPlayerNotFoundError],
          CONFLICT: [
            InsufficientBalanceError,
            ExceedsLimitError,
            BelowMinimumError,
            DonateSelfError,
            ChatCommandIdempotencyKeyReuseError,
            ConcurrentCommandReplayError,
          ],
          FORBIDDEN: [ChatRoomNotMemberError],
        },
        () => svc.sendDonate(input, actorId),
      );
    }),
  });
}

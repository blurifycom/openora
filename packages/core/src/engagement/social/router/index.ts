import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@openora/core/server';
import { socialContract } from '../contract/index.js';
import {
  SocialService,
  SelfFriendRequestError,
  FriendRequestTargetNotFoundError,
  FriendRequestUnavailableError,
  AlreadyFriendsError,
  RequestAlreadyPendingError,
  FriendRequestRefusedError,
  BlockedBySelfError,
  FriendshipNotFoundError,
  FriendRequestNotFoundError,
} from '../service/social.service.js';

// oRPC router factory for Social. plugin.ts builds the service from the
// container and passes it here; each procedure delegates to the service. Keep this
// thin: resolve the caller, call the service, map domain errors - no business rules.
export function createSocialRouter(social: SocialService) {
  const os = implement(socialContract).$context<OssContext>();

  return os.router({
    sendFriendRequest: os.sendFriendRequest.handler(({ input, context }) => {
      const callerId = getUserId(context);
      return mapErrors(
        {
          BAD_REQUEST: [SelfFriendRequestError],
          NOT_FOUND: [FriendRequestTargetNotFoundError],
          CONFLICT: [
            AlreadyFriendsError,
            RequestAlreadyPendingError,
            FriendRequestRefusedError,
            FriendRequestUnavailableError,
            BlockedBySelfError,
          ],
        },
        () => social.sendFriendRequest(callerId, input.targetUserId),
      );
    }),

    getRelationships: os.getRelationships.handler(({ input, context }) => {
      const callerId = getUserId(context);
      return social.getRelationships(callerId, input.userIds);
    }),

    listFriends: os.listFriends.handler(({ input, context }) => {
      const callerId = getUserId(context);
      return social.listFriends(callerId, { page: input.page, limit: input.limit });
    }),

    removeFriend: os.removeFriend.handler(({ input, context }) => {
      const callerId = getUserId(context);
      return mapErrors({ NOT_FOUND: [FriendshipNotFoundError] }, async () => {
        await social.removeFriend(callerId, input.targetUserId);
        return { success: true as const };
      });
    }),

    listFriendRequests: os.listFriendRequests.handler(({ input, context }) => {
      const callerId = getUserId(context);
      return social.listFriendRequests(callerId, {
        direction: input.direction,
        page: input.page,
        limit: input.limit,
      });
    }),

    acceptFriendRequest: os.acceptFriendRequest.handler(({ input, context }) => {
      const callerId = getUserId(context);
      return mapErrors({ NOT_FOUND: [FriendRequestNotFoundError] }, () =>
        social.acceptFriendRequest(callerId, input.friendshipId),
      );
    }),

    declineFriendRequest: os.declineFriendRequest.handler(({ input, context }) => {
      const callerId = getUserId(context);
      return mapErrors({ NOT_FOUND: [FriendRequestNotFoundError] }, async () => {
        await social.declineFriendRequest(callerId, input.friendshipId);
        return { success: true as const };
      });
    }),

    cancelFriendRequest: os.cancelFriendRequest.handler(({ input, context }) => {
      const callerId = getUserId(context);
      return mapErrors({ NOT_FOUND: [FriendRequestNotFoundError] }, async () => {
        await social.cancelFriendRequest(callerId, input.friendshipId);
        return { success: true as const };
      });
    }),
  });
}

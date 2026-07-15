import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import {
  mapErrors,
  createEventStreamGenerator,
  getUserId,
  AdminGuard,
  type OssContext,
} from '@openora/core/server';
import type { RealtimeClientAuthorizer } from '@openora/core/contracts';
import { chatContract } from '../contract/index.js';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
  ChatMessageBlockedError,
  ChatSelfBlockError,
  ChatRoomSlugConflictError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomBannedError,
} from '../service/chat.service.js';

const chat = populateContractRouterPaths({ chat: chatContract }).chat;

function resolveUsername(context: OssContext, fallback = 'anonymous') {
  const val = context.request.headers['x-username'];
  if (Array.isArray(val)) {
    return val[0] ?? fallback;
  }
  return typeof val === 'string' ? val : fallback;
}

// Reads work for anonymous viewers; when authenticated, the id drives per-viewer
// block filtering (ABC-45 AC11). Sourced from server-verified `auth`, never a header.
function resolveViewerId(context: OssContext) {
  return context.auth?.userId;
}

export function createChatRouter(
  chatService: ChatService,
  authorizer: RealtimeClientAuthorizer,
  adminGuard: AdminGuard,
) {
  const os = implement(chat).$context<OssContext>();

  return os.router({
    listRooms: os.listRooms.handler(({ context }) =>
      chatService.listRooms(resolveViewerId(context)),
    ),

    getRoomMessages: os.getRoomMessages.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError }, () =>
        chatService.getRoomMessages({
          roomId: input.roomId,
          limit: input.limit,
          before: input.before,
          viewerId: resolveViewerId(context),
        }),
      ),
    ),

    sendRoomMessage: os.sendRoomMessage.handler(({ input, context }) => {
      const userId = getUserId(context);
      const username = resolveUsername(context);
      return mapErrors(
        {
          NOT_FOUND: ChatRoomNotFoundError,
          FORBIDDEN: ChatRoomNotMemberError,
          BAD_REQUEST: ChatMessageBlockedError,
        },
        () =>
          chatService.sendRoomMessage({
            userId,
            username,
            roomId: input.roomId,
            content: input.content,
          }),
      );
    }),

    deleteMessage: os.deleteMessage.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors(
        { NOT_FOUND: ChatMessageNotFoundError, FORBIDDEN: ChatMessageOwnershipError },
        () => chatService.deleteMessage(input.id, userId),
      );
    }),

    getGlobalMessages: os.getGlobalMessages.handler(({ context }) =>
      chatService.getGlobalMessages(undefined, resolveViewerId(context)),
    ),

    sendGlobalMessage: os.sendGlobalMessage.handler(({ input, context }) => {
      const userId = getUserId(context);
      const username = resolveUsername(context);
      return mapErrors({ BAD_REQUEST: ChatMessageBlockedError }, () =>
        chatService.sendGlobalMessage(userId, username, input.content),
      );
    }),

    // Grant includes all rooms the player has access to (public + private memberships)
    // so Ably clients can subscribe to any accessible room without re-auth.
    getConnection: os.getConnection.handler(async ({ input, context }) => {
      const userId = getUserId(context);
      context.resHeaders?.set('cache-control', 'no-store');
      const rooms = await chatService.listRooms(userId);
      const channels = [chatChannel(null), ...rooms.map((r) => chatChannel(r.id))];
      return authorizer.issueGrant({ userId, clientId: input.clientId ?? userId, channels });
    }),

    streamMessages: os.streamMessages.handler(async ({ input, signal, context }) => {
      const viewerId = resolveViewerId(context);
      const roomId = input.roomId ?? null;
      if (roomId) {
        await mapErrors(
          { NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError },
          () => chatService.verifyRoomAccess(roomId, viewerId),
        );
      }
      return createEventStreamGenerator(
        (push) => chatService.subscribeMessages(roomId, push, viewerId),
        { signal },
      );
    }),

    listBlockedUsers: os.listBlockedUsers.handler(({ context }) =>
      chatService.listBlockedUsers(getUserId(context)),
    ),

    blockUser: os.blockUser.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors({ BAD_REQUEST: ChatSelfBlockError }, () =>
        chatService.blockUser(userId, input.blockedId),
      );
    }),

    unblockUser: os.unblockUser.handler(({ input, context }) =>
      chatService.unblockUser(getUserId(context), input.blockedId),
    ),

    // Private room player routes.
    createPrivateRoom: os.createPrivateRoom.handler(({ input, context }) => {
      const userId = getUserId(context);
      return chatService.createPrivateRoom({ userId, name: input.name });
    }),

    joinRoom: os.joinRoom.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors(
        { NOT_FOUND: ChatRoomJoinCodeNotFoundError, FORBIDDEN: ChatRoomBannedError },
        () => chatService.joinRoom({ userId, joinCode: input.joinCode }),
      );
    }),

    leaveRoom: os.leaveRoom.handler(({ input, context }) => {
      const userId = getUserId(context);
      return chatService.leaveRoom({ userId, roomId: input.roomId });
    }),

    getRoom: os.getRoom.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError }, () =>
        chatService.getRoom({ roomId: input.roomId, viewerId: resolveViewerId(context) }),
      ),
    ),

    kickMember: os.kickMember.handler(({ input, context }) => {
      const moderatorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: ChatRoomNotFoundError,
          FORBIDDEN: ChatRoomNotModeratorError,
          BAD_REQUEST: ChatRoomSelfModerationError,
        },
        () => chatService.kickMember({ moderatorId, roomId: input.roomId, userId: input.userId }),
      );
    }),

    banMember: os.banMember.handler(({ input, context }) => {
      const moderatorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: ChatRoomNotFoundError,
          FORBIDDEN: ChatRoomNotModeratorError,
          BAD_REQUEST: ChatRoomSelfModerationError,
        },
        () => chatService.banMember({ moderatorId, roomId: input.roomId, userId: input.userId }),
      );
    }),

    listRoomMembers: os.listRoomMembers.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError }, () =>
        chatService.listRoomMembers({
          roomId: input.roomId,
          viewerId: resolveViewerId(context),
        }),
      ),
    ),

    // Admin-only routes (AdminGuard.assert enforced at handler level).
    createRoom: os.createRoom.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'chat-room', 'create');
      return mapErrors({ CONFLICT: ChatRoomSlugConflictError }, () =>
        chatService.createRoom(input),
      );
    }),

    deleteRoom: os.deleteRoom.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'chat-room', 'delete');
      return mapErrors({ NOT_FOUND: ChatRoomNotFoundError }, () =>
        chatService.deleteRoom(input.id),
      );
    }),
  });
}

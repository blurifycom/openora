import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import {
  mapErrors,
  createEventStreamGenerator,
  getUserId,
  AdminGuard,
  assertRateLimit,
  type OssContext,
} from '@openora/core/server';
import {
  makeRateLimitKey,
  RATE_LIMIT_KEYS,
  type RateLimiterAdapter,
  type RealtimeClientAuthorizer,
} from '@openora/core/contracts';
import { chatContract } from '../contract/index.js';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
  ChatRoomLastModeratorError,
  ChatRoomLimitReachedError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
  ChatMessageBlockedError,
  ChatSelfBlockError,
  ChatRoomSlugConflictError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomBannedError,
} from '../service/chat.service.js';

const chat = populateContractRouterPaths({ chat: chatContract }).chat;
const JOIN_ROOM_RATE_LIMIT = {
  limit: 5,
  windowMs: 15 * 60 * 1_000,
  onUnavailable: 'deny',
} as const;

const SEND_MESSAGE_RATE_LIMIT = {
  limit: 10,
  windowMs: 10_000,
  onUnavailable: 'allow',
} as const;

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

export function createChatRouter({
  chatService,
  authorizer,
  adminGuard,
  limiter,
}: {
  chatService: ChatService;
  authorizer: RealtimeClientAuthorizer;
  adminGuard: AdminGuard;
  limiter: RateLimiterAdapter;
}) {
  const os = implement(chat).$context<OssContext>();

  return os.router({
    listRooms: os.listRooms.handler(({ context }) => {
      return chatService.listRooms(resolveViewerId(context));
    }),

    getRoomMessages: os.getRoomMessages.handler(({ input, context }) => {
      const viewerId = resolveViewerId(context);
      return mapErrors(
        { NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError },
        () =>
          chatService.getRoomMessages({
            roomId: input.roomId,
            limit: input.limit,
            before: input.before,
            viewerId,
          }),
      );
    }),

    sendRoomMessage: os.sendRoomMessage.handler(async ({ input, context }) => {
      const userId = getUserId(context);
      const username = resolveUsername(context);
      await assertRateLimit(
        limiter,
        makeRateLimitKey(RATE_LIMIT_KEYS.CHAT_SEND, userId),
        SEND_MESSAGE_RATE_LIMIT,
      );
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

    sendGlobalMessage: os.sendGlobalMessage.handler(async ({ input, context }) => {
      const userId = getUserId(context);
      const username = resolveUsername(context);
      await assertRateLimit(
        limiter,
        makeRateLimitKey(RATE_LIMIT_KEYS.CHAT_SEND, userId),
        SEND_MESSAGE_RATE_LIMIT,
      );
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
      const roomId = input.roomId ?? null;
      // Private-room streams require membership; public-room and global streams are readable anonymously.
      const viewerId = resolveViewerId(context);
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

    getOnlineCount: os.getOnlineCount.handler(async ({ input, context }) => {
      const roomId = input.roomId ?? null;
      if (roomId) {
        await mapErrors(
          { NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError },
          () => chatService.verifyRoomAccess(roomId, resolveViewerId(context)),
        );
      }
      return chatService.getOnlineCount(roomId);
    }),

    listBlockedUsers: os.listBlockedUsers.handler(({ context }) =>
      chatService.listBlockedUsers(getUserId(context)),
    ),

    blockUser: os.blockUser.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors({ BAD_REQUEST: ChatSelfBlockError }, () =>
        chatService.blockUser(userId, input.blockedId, context.clientMeta),
      );
    }),

    unblockUser: os.unblockUser.handler(({ input, context }) => {
      return chatService.unblockUser(getUserId(context), input.blockedId, context.clientMeta);
    }),

    createPrivateRoom: os.createPrivateRoom.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors({ CONFLICT: ChatRoomLimitReachedError }, () =>
        chatService.createPrivateRoom({ userId, name: input.name, ...context.clientMeta }),
      );
    }),

    joinRoom: os.joinRoom.handler(async ({ input, context }) => {
      const userId = getUserId(context);
      await assertRateLimit(
        limiter,
        makeRateLimitKey(RATE_LIMIT_KEYS.CHAT_ROOM_JOIN, userId),
        JOIN_ROOM_RATE_LIMIT,
      );
      return mapErrors(
        { NOT_FOUND: ChatRoomJoinCodeNotFoundError, FORBIDDEN: ChatRoomBannedError },
        () => chatService.joinRoom({ userId, joinCode: input.joinCode, ...context.clientMeta }),
      );
    }),

    leaveRoom: os.leaveRoom.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors({ BAD_REQUEST: ChatRoomLastModeratorError }, () =>
        chatService.leaveRoom({ userId, roomId: input.roomId, ...context.clientMeta }),
      );
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
        () =>
          chatService.kickMember({
            moderatorId,
            roomId: input.roomId,
            userId: input.userId,
            ...context.clientMeta,
          }),
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
        () =>
          chatService.banMember({
            moderatorId,
            roomId: input.roomId,
            userId: input.userId,
            ...context.clientMeta,
          }),
      );
    }),

    listRoomMembers: os.listRoomMembers.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError }, () =>
        chatService.listRoomMembers({
          roomId: input.roomId,
          viewerId: getUserId(context),
        }),
      ),
    ),

    createRoom: os.createRoom.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'chat-room', 'create');
      return mapErrors({ CONFLICT: ChatRoomSlugConflictError }, () =>
        chatService.createRoom({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    updateRoom: os.updateRoom.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'chat-room', 'update');
      return mapErrors(
        { NOT_FOUND: ChatRoomNotFoundError, CONFLICT: ChatRoomSlugConflictError },
        () => chatService.updateRoom({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    listAdminRooms: os.listAdminRooms.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'chat-room', 'view');
      return chatService.listAdminRooms(input);
    }),

    deleteRoom: os.deleteRoom.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'chat-room', 'delete');
      return mapErrors({ NOT_FOUND: ChatRoomNotFoundError }, () =>
        chatService.deleteRoom(input.id, userId, { ip, userAgent }),
      );
    }),
  });
}

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
  chatChannel,
  type ChatModeration,
  type RateLimiterAdapter,
  type RealtimeClientAuthorizer,
} from '@openora/core/contracts';
import { chatContract } from '../contract/index.js';
import {
  ChatService,
  ChatRoomOwnershipError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
  ChatRoomLastModeratorError,
  ChatRoomLimitReachedError,
  ChatMessageOwnershipError,
  ChatMessageBlockedError,
  ChatSelfBlockError,
  ChatSelfIgnoreError,
  ChatRoomSlugConflictError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomBannedError,
  ChatRoomNotMemberError,
  ChatRoomRuleNotFoundError,
} from '../service/chat.service.js';
import {
  ChatMessageNotFoundError,
  ChatPlayerMutedError,
  ChatPlayerBannedError,
  ChatAdminPrivateRoomModerationError,
  ChatRoomNotFoundError,
} from '../service/chat-moderation.service.js';

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
  moderationService,
  authorizer,
  adminGuard,
  limiter,
}: {
  chatService: ChatService;
  moderationService: ChatModeration;
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
        {
          NOT_FOUND: ChatRoomNotFoundError,
          FORBIDDEN: [ChatRoomNotMemberError, ChatPlayerMutedError, ChatPlayerBannedError],
        },
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
          FORBIDDEN: [ChatRoomNotMemberError, ChatPlayerMutedError, ChatPlayerBannedError],
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
      return mapErrors(
        {
          BAD_REQUEST: ChatMessageBlockedError,
          FORBIDDEN: [ChatPlayerMutedError, ChatPlayerBannedError],
        },
        () => chatService.sendGlobalMessage(userId, username, input.content),
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

    listBlockedUsers: os.listBlockedUsers.handler(({ input, context }) =>
      chatService.listBlockedUsers({ blockerId: getUserId(context), ...input }),
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

    listIgnoredUsers: os.listIgnoredUsers.handler(({ input, context }) =>
      chatService.listIgnoredUsers({ ignorerId: getUserId(context), ...input }),
    ),

    ignoreUser: os.ignoreUser.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors({ BAD_REQUEST: ChatSelfIgnoreError }, () =>
        chatService.ignoreUser(userId, input.ignoredId, context.clientMeta),
      );
    }),

    unignoreUser: os.unignoreUser.handler(({ input, context }) => {
      return chatService.unignoreUser(getUserId(context), input.ignoredId, context.clientMeta);
    }),

    createPrivateRoom: os.createPrivateRoom.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors({ CONFLICT: ChatRoomLimitReachedError }, () =>
        chatService.createPrivateRoom({ userId, name: input.name, ...context.clientMeta }),
      );
    }),

    deletePrivateRoom: os.deletePrivateRoom.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors(
        { NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomOwnershipError },
        () =>
          chatService.deletePrivateRoom({ roomId: input.roomId, userId, ...context.clientMeta }),
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

    joinPublicRoom: os.joinPublicRoom.handler(async ({ input, context }) => {
      const userId = getUserId(context);
      await assertRateLimit(
        limiter,
        makeRateLimitKey(RATE_LIMIT_KEYS.CHAT_ROOM_JOIN, userId),
        JOIN_ROOM_RATE_LIMIT,
      );
      return mapErrors({ NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomBannedError }, () =>
        chatService.joinPublicRoom({ roomId: input.roomId, userId, ...context.clientMeta }),
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

    getRoomRules: os.getRoomRules.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError }, () =>
        chatService.listRoomRules(input.roomId, resolveViewerId(context)),
      ),
    ),

    createRoomRule: os.createRoomRule.handler(({ input, context }) =>
      mapErrors(
        {
          NOT_FOUND: ChatRoomNotFoundError,
          FORBIDDEN: [ChatRoomNotMemberError, ChatRoomNotModeratorError],
        },
        () => chatService.createRoomRule({ ...input, actorId: getUserId(context) }),
      ),
    ),

    updateRoomRule: os.updateRoomRule.handler(({ input, context }) =>
      mapErrors(
        { FORBIDDEN: ChatRoomNotModeratorError, BAD_REQUEST: ChatRoomRuleNotFoundError },
        () => chatService.updateRoomRule({ ...input, actorId: getUserId(context) }),
      ),
    ),

    deleteRoomRule: os.deleteRoomRule.handler(({ input, context }) =>
      mapErrors(
        { FORBIDDEN: ChatRoomNotModeratorError, BAD_REQUEST: ChatRoomRuleNotFoundError },
        () => chatService.deleteRoomRule({ ...input, actorId: getUserId(context) }),
      ),
    ),

    getRoomConfiguration: os.getRoomConfiguration.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: ChatRoomNotFoundError, FORBIDDEN: ChatRoomNotMemberError }, () =>
        chatService.getRoomConfiguration(input.roomId, resolveViewerId(context)),
      ),
    ),

    updateRoomConfiguration: os.updateRoomConfiguration.handler(({ input, context }) =>
      mapErrors({ FORBIDDEN: ChatRoomNotModeratorError }, () =>
        chatService.updateRoomConfiguration({ ...input, actorId: getUserId(context) }),
      ),
    ),

    listRoomUsers: os.listRoomUsers.handler(({ input, context }) =>
      mapErrors({ FORBIDDEN: ChatRoomNotModeratorError }, () =>
        chatService.listRoomUsers({ ...input, actorId: getUserId(context) }),
      ),
    ),

    listRoomBlockedUsers: os.listRoomBlockedUsers.handler(({ input, context }) =>
      mapErrors({ FORBIDDEN: ChatRoomNotModeratorError }, () =>
        chatService.listRoomBlockedUsers({ ...input, actorId: getUserId(context) }),
      ),
    ),

    removeMember: os.removeMember.handler(({ input, context }) => {
      const moderatorId = getUserId(context);
      return mapErrors(
        {
          NOT_FOUND: ChatRoomNotFoundError,
          FORBIDDEN: ChatRoomNotModeratorError,
          BAD_REQUEST: ChatRoomSelfModerationError,
        },
        () =>
          chatService.removeMember({
            moderatorId,
            roomId: input.roomId,
            userId: input.userId,
            ...context.clientMeta,
          }),
      );
    }),

    banRoomMember: os.banRoomMember.handler(({ input, context }) => {
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
            durationSeconds: input.durationSeconds,
            reason: input.reason,
            ...context.clientMeta,
          }),
      );
    }),

    unbanRoomMember: os.unbanRoomMember.handler(({ input, context }) =>
      mapErrors({ FORBIDDEN: ChatRoomNotModeratorError }, () =>
        chatService.unbanMember({ ...input, moderatorId: getUserId(context) }),
      ),
    ),

    muteRoomMember: os.muteRoomMember.handler(({ input, context }) =>
      mapErrors({ FORBIDDEN: ChatRoomNotModeratorError }, () =>
        chatService.muteRoomMember({
          roomId: input.roomId,
          userId: input.userId,
          moderatorId: getUserId(context),
          durationSeconds: input.durationSeconds,
          reason: input.reason,
        }),
      ),
    ),

    unmuteRoomMember: os.unmuteRoomMember.handler(({ input, context }) =>
      mapErrors({ FORBIDDEN: ChatRoomNotModeratorError }, () =>
        chatService.unmuteRoomMember({ ...input, moderatorId: getUserId(context) }),
      ),
    ),

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

    adminListBlockedUsers: os.adminListBlockedUsers.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'chat-moderation', 'view');
      return chatService.adminListBlockedUsers(input);
    }),

    adminListIgnoredUsers: os.adminListIgnoredUsers.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'chat-moderation', 'view');
      return chatService.adminListIgnoredUsers(input);
    }),

    adminMute: os.adminMute.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(
        context,
        'chat-moderation',
        'moderate',
      );
      return mapErrors(
        {
          NOT_FOUND: ChatRoomNotFoundError,
          BAD_REQUEST: ChatAdminPrivateRoomModerationError,
        },
        () => moderationService.mute({ ...input, actorId: userId, ip, userAgent }),
      );
    }),

    adminUnmute: os.adminUnmute.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(
        context,
        'chat-moderation',
        'moderate',
      );
      return moderationService.unmute({ ...input, actorId: userId, ip, userAgent });
    }),

    adminListMutes: os.adminListMutes.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'chat-moderation', 'view');
      return moderationService.listMutes(input.userId);
    }),

    adminBan: os.adminBan.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(
        context,
        'chat-moderation',
        'moderate',
      );
      return moderationService.ban({ ...input, actorId: userId, ip, userAgent });
    }),

    adminUnban: os.adminUnban.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(
        context,
        'chat-moderation',
        'moderate',
      );
      return moderationService.unban({ ...input, actorId: userId, ip, userAgent });
    }),

    adminListBans: os.adminListBans.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'chat-moderation', 'view');
      return moderationService.listBans(input.userId);
    }),

    adminDeleteMessage: os.adminDeleteMessage.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(
        context,
        'chat-moderation',
        'moderate',
      );
      return mapErrors({ NOT_FOUND: ChatMessageNotFoundError }, () =>
        moderationService.deleteMessage(input.id, userId, { ip, userAgent }),
      );
    }),
  });
}

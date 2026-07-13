import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import {
  mapErrors,
  createEventStreamGenerator,
  getUserId,
  type OssContext,
} from '@openora/core/server';
import type { RealtimeClientAuthorizer } from '@openora/core/contracts';
import { chatContract } from '../contract/index.js';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
  ChatMessageBlockedError,
  ChatSelfBlockError,
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

export function createChatRouter(chatService: ChatService, authorizer: RealtimeClientAuthorizer) {
  const os = implement(chat).$context<OssContext>();

  return os.router({
    listRooms: os.listRooms.handler(() => chatService.listRooms()),

    getRoomMessages: os.getRoomMessages.handler(({ input, context }) =>
      mapErrors({ NOT_FOUND: ChatRoomNotFoundError }, () =>
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
        { NOT_FOUND: ChatRoomNotFoundError, BAD_REQUEST: ChatMessageBlockedError },
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

    getConnection: os.getConnection.handler(({ input, context }) => {
      const userId = getUserId(context);
      // Grant is a per-player single-use nonce - must never be cached.
      context.resHeaders?.set('cache-control', 'no-store');
      // Server is authoritative on channel scope; never trusts a client-supplied list.
      const channels = [chatChannel(null)];
      return Promise.resolve(
        authorizer.issueGrant({ userId, clientId: input.clientId ?? userId, channels }),
      );
    }),

    streamMessages: os.streamMessages.handler(({ input, signal, context }) => {
      const viewerId = resolveViewerId(context);
      return createEventStreamGenerator(
        (push) => chatService.subscribeMessages(input.roomId ?? null, push, viewerId),
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
  });
}

import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import {
  mapErrors,
  createEventStreamGenerator,
  getUserId,
  type OssContext,
} from '@oss/core/server';
import type { RealtimeClientAuthorizer } from '@oss/core/contracts';
import { chatContract } from '../contract/index.js';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
} from '../service/chat.service.js';

const chat = populateContractRouterPaths({ chat: chatContract }).chat;

function resolveUsername(context: OssContext, fallback = 'anonymous'): string {
  const val = context.request.headers['x-username'];
  if (Array.isArray(val)) return val[0] ?? fallback;
  return typeof val === 'string' ? val : fallback;
}

export function createChatRouter(chatService: ChatService, authorizer: RealtimeClientAuthorizer) {
  const os = implement(chat).$context<OssContext>();

  return os.router({
    listRooms: os.listRooms.handler(() => chatService.listRooms()),

    getRoomMessages: os.getRoomMessages.handler(({ input }) =>
      mapErrors({ NOT_FOUND: ChatRoomNotFoundError }, () =>
        chatService.getRoomMessages(input.roomId, input.limit, input.before),
      ),
    ),

    sendRoomMessage: os.sendRoomMessage.handler(({ input, context }) => {
      const userId = getUserId(context);
      const username = resolveUsername(context);
      return mapErrors({ NOT_FOUND: ChatRoomNotFoundError }, () =>
        chatService.sendRoomMessage(userId, username, input.roomId, input.content),
      );
    }),

    deleteMessage: os.deleteMessage.handler(({ input, context }) => {
      const userId = getUserId(context);
      return mapErrors(
        { NOT_FOUND: ChatMessageNotFoundError, FORBIDDEN: ChatMessageOwnershipError },
        () => chatService.deleteMessage(input.id, userId),
      );
    }),

    getGlobalMessages: os.getGlobalMessages.handler(() => chatService.getGlobalMessages()),

    sendGlobalMessage: os.sendGlobalMessage.handler(({ input, context }) => {
      const userId = getUserId(context);
      const username = resolveUsername(context);
      return chatService.sendGlobalMessage(userId, username, input.content);
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

    streamMessages: os.streamMessages.handler(({ input, signal }) =>
      createEventStreamGenerator((push) => chatService.subscribeMessages(input.roomId, push), {
        signal,
      }),
    ),
  });
}

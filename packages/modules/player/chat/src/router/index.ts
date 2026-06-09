import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import { mapErrors, createEventStreamGenerator, getUserId, type OssContext } from '@oss/core';
import { chatContract } from '@oss/orpc-contract/chat';
import {
  ChatService,
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

export function createChatRouter(chatService: ChatService) {
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

    streamMessages: os.streamMessages.handler(({ input, signal }) =>
      createEventStreamGenerator((push) => chatService.subscribeMessages(input.roomId, push), {
        signal,
      }),
    ),
  });
}

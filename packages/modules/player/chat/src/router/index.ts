import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import { mapErrors, type OssContext } from '@oss/core';
import { chatContract } from '@oss/orpc-contract/chat';
import {
  ChatService,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
} from '../service/chat.service.js';

const chat = populateContractRouterPaths({ chat: chatContract }).chat;

function extractHeader(context: unknown, header: string, fallback: string): string {
  const ctx = context as Record<string, unknown>;
  const req = ctx['request'] as Record<string, unknown> | undefined;
  if (!req) return fallback;
  const headers = req['headers'] as Record<string, unknown> | undefined;
  if (!headers) return fallback;
  const val = headers[header];
  if (Array.isArray(val)) return String(val[0] ?? fallback);
  if (typeof val === 'string') return val;
  return fallback;
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
      const userId = extractHeader(context, 'x-user-id', 'anonymous');
      const username = extractHeader(context, 'x-username', 'anonymous');
      return mapErrors({ NOT_FOUND: ChatRoomNotFoundError }, () =>
        chatService.sendRoomMessage(userId, username, input.roomId, input.content),
      );
    }),

    deleteMessage: os.deleteMessage.handler(({ input, context }) => {
      const userId = extractHeader(context, 'x-user-id', 'anonymous');
      return mapErrors(
        { NOT_FOUND: ChatMessageNotFoundError, FORBIDDEN: ChatMessageOwnershipError },
        () => chatService.deleteMessage(input.id, userId),
      );
    }),

    getGlobalMessages: os.getGlobalMessages.handler(() => chatService.getGlobalMessages()),

    sendGlobalMessage: os.sendGlobalMessage.handler(({ input, context }) => {
      const userId = extractHeader(context, 'x-user-id', 'anonymous');
      const username = extractHeader(context, 'x-username', 'anonymous');
      return chatService.sendGlobalMessage(userId, username, input.content);
    }),
  });
}

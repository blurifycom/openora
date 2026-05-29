import { implement } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
import { mapErrors, type OssContext } from '@oss/core';
import { chatContract } from '@oss/orpc-contract/chat';
import type { ChatMessage } from '../schemas/index.js';
import {
  ChatService,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
} from '../service/chat.service.js';

// Bridge the service's push-style message listener into a pull-style async
// generator for SSE. A bounded buffer holds messages between yields; a resolver
// wakes the generator when one arrives. The handler's abort signal tears the
// subscription down so each connection cleans up after itself. Mirrors the
// sportsbook odds stream.
async function* streamMessages(
  chatService: ChatService,
  roomId: string | null,
  signal: AbortSignal | undefined,
): AsyncGenerator<ChatMessage> {
  const queue: ChatMessage[] = [];
  let resolve: (() => void) | undefined;
  let done = false;

  const wake = () => {
    resolve?.();
    resolve = undefined;
  };

  const unsubscribe = chatService.subscribeMessages(roomId, (message) => {
    queue.push(message);
    wake();
  });

  const onAbort = () => {
    done = true;
    wake();
  };
  signal?.addEventListener('abort', onAbort);

  try {
    while (!done && !signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          resolve = r;
        });
        continue;
      }
      const next = queue.shift();
      if (next) yield next;
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
  }
}

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

    streamMessages: os.streamMessages.handler(({ input, signal }) =>
      streamMessages(chatService, input.roomId, signal),
    ),
  });
}

import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { populateContractRouterPaths } from '@orpc/contract';
import { mapErrors } from '@oss/core';
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

@Controller()
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Implement(chat)
  chat() {
    return {
      listRooms: implement(chat.listRooms).handler(() => this.chatService.listRooms()),

      getRoomMessages: implement(chat.getRoomMessages).handler(({ input }) =>
        mapErrors(
          { NOT_FOUND: ChatRoomNotFoundError },
          () => this.chatService.getRoomMessages(input.roomId, input.limit, input.before),
        ),
      ),

      sendRoomMessage: implement(chat.sendRoomMessage).handler(({ input, context }) => {
        const userId = extractHeader(context, 'x-user-id', 'anonymous');
        const username = extractHeader(context, 'x-username', 'anonymous');
        return mapErrors(
          { NOT_FOUND: ChatRoomNotFoundError },
          () => this.chatService.sendRoomMessage(userId, username, input.roomId, input.content),
        );
      }),

      deleteMessage: implement(chat.deleteMessage).handler(({ input, context }) => {
        const userId = extractHeader(context, 'x-user-id', 'anonymous');
        return mapErrors(
          { NOT_FOUND: ChatMessageNotFoundError, FORBIDDEN: ChatMessageOwnershipError },
          () => this.chatService.deleteMessage(input.id, userId),
        );
      }),

      getGlobalMessages: implement(chat.getGlobalMessages).handler(() =>
        this.chatService.getGlobalMessages(),
      ),

      sendGlobalMessage: implement(chat.sendGlobalMessage).handler(async ({ input, context }) => {
        const userId = extractHeader(context, 'x-user-id', 'anonymous');
        const username = extractHeader(context, 'x-username', 'anonymous');
        return this.chatService.sendGlobalMessage(userId, username, input.content);
      }),
    };
  }
}

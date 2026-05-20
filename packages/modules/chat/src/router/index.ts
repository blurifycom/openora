import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import { populateContractRouterPaths } from '@orpc/contract';
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

      getRoomMessages: implement(chat.getRoomMessages).handler(async ({ input }) => {
        try {
          return await this.chatService.getRoomMessages(input.roomId, input.limit, input.before);
        } catch (err) {
          if (err instanceof ChatRoomNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      sendRoomMessage: implement(chat.sendRoomMessage).handler(async ({ input, context }) => {
        const userId = extractHeader(context, 'x-user-id', 'anonymous');
        const username = extractHeader(context, 'x-username', 'anonymous');
        try {
          return await this.chatService.sendRoomMessage(
            userId,
            username,
            input.roomId,
            input.content,
          );
        } catch (err) {
          if (err instanceof ChatRoomNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      deleteMessage: implement(chat.deleteMessage).handler(async ({ input, context }) => {
        const userId = extractHeader(context, 'x-user-id', 'anonymous');
        try {
          return await this.chatService.deleteMessage(input.id, userId);
        } catch (err) {
          if (err instanceof ChatMessageNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          if (err instanceof ChatMessageOwnershipError) {
            throw new ORPCError('FORBIDDEN', { message: err.message });
          }
          throw err;
        }
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

import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type { SystemChatMessage } from '../schemas/chat-command.js';
import type { SystemEventMetadata } from '../schemas/chat-command-metadata.js';
import type { ChatContextRoom, EnsureChatContextRoomInput } from '../schemas/chat-context-room.js';

export type ChatContextRoomWrite<T> = T & { afterCommit(): Promise<void> };

export type ChatContextRooms = {
  ensureRoom(
    input: EnsureChatContextRoomInput & { tx?: unknown },
  ): Promise<
    ChatContextRoomWrite<{ room: ChatContextRoom; created: boolean; addedMemberIds: Uuid[] }>
  >;
  findRoom(ref: string, tx?: unknown): Promise<ChatContextRoom | null>;
  addMember(input: {
    ref: string;
    userId: Uuid;
    tx?: unknown;
  }): Promise<ChatContextRoomWrite<{ added: boolean }>>;
  removeMember(input: {
    ref: string;
    userId: Uuid;
    tx?: unknown;
  }): Promise<ChatContextRoomWrite<{ removed: boolean }>>;
  close(input: { ref: string; tx?: unknown }): Promise<ChatContextRoomWrite<{ closed: boolean }>>;
  postSystemEvent(input: {
    ref: string;
    messageId?: Uuid;
    code: SystemEventMetadata['code'];
    params?: SystemEventMetadata['params'];
    tx?: unknown;
  }): Promise<ChatContextRoomWrite<{ message: SystemChatMessage }>>;
};

export const CHAT_CONTEXT_ROOMS: Token<ChatContextRooms> = createToken('CHAT_CONTEXT_ROOMS');

type CommandIssued = Promise<{ afterCommit(): Promise<void> }>;

export type ChatContextRoomCommands = {
  ensureRoom(
    input: Parameters<ChatContextRooms['ensureRoom']>[0] & { roomId: Uuid },
  ): CommandIssued;
  close(input: Parameters<ChatContextRooms['close']>[0]): CommandIssued;
  postSystemEvent(
    input: Parameters<ChatContextRooms['postSystemEvent']>[0] & { messageId: Uuid },
  ): CommandIssued;
};

export const CHAT_CONTEXT_ROOM_COMMANDS: Token<ChatContextRoomCommands> = createToken(
  'CHAT_CONTEXT_ROOM_COMMANDS',
);

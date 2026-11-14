import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type { SystemChatMessage } from '../schemas/chat-command.js';
import type { SystemEventMetadata } from '../schemas/chat-command-metadata.js';
import type { ChatContextRoom, EnsureChatContextRoomInput } from '../schemas/chat-context-room.js';

// With `tx` the write joins the caller's transaction and its realtime effects wait for
// `afterCommit`, which the caller runs once that transaction commits. Without `tx` they
// have already run when the call returns. A write holds the room lock, then the global audit lock,
// until commit: a shared transaction should touch one context room, before its own audit rows.
export type ChatContextRoomWrite<T> = T & { afterCommit(): Promise<void> };

/**
 * Member-only rooms owned by server code and keyed by the caller's own `ref`. They have no
 * owner or moderators, never appear in a player's room list, and players reach them only
 * through the room history, send and stream routes. Closing one stops players posting for good.
 */
export type ChatContextRooms = {
  /** Creates the room or returns the existing one, adding any `memberIds` not yet in it. */
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
  /** Also ends the member's open room stream. */
  removeMember(input: {
    ref: string;
    userId: Uuid;
    tx?: unknown;
  }): Promise<ChatContextRoomWrite<{ removed: boolean }>>;
  close(input: { ref: string; tx?: unknown }): Promise<ChatContextRoomWrite<{ closed: boolean }>>;
  /**
   * Posts as the system author; allowed in a closed room. `messageId` keys the message on the
   * caller's own id; an id that already names a message fails the write.
   */
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

/**
 * The `ChatContextRooms` writes a caller can make without reading chat back, so they work
 * whether chat shares the caller's database or not. The caller names the room (`roomId`, its
 * own record id) and the message (`messageId`), and knows the members from its own records.
 *
 * The chat module binds the local `ChatContextRooms` here: each write joins the caller's `tx` and
 * `afterCommit` runs its realtime effects. A service that runs without chat binds
 * `OutboxChatContextRoomCommands` over it: each write is a `chat.context_room.command_issued`
 * event on the caller's `tx` (or its own when none is given), `afterCommit` does nothing, and
 * chat applies the command once the event is relayed. In that mode a write lands after the
 * caller's commit, and one chat cannot apply (an unknown ref, a `roomId` or `messageId` that
 * names another room or message) fails in chat, never in the committed caller.
 */
export type ChatContextRoomCommands = {
  ensureRoom(
    input: Parameters<ChatContextRooms['ensureRoom']>[0] & { roomId: Uuid },
  ): CommandIssued;
  addMember(input: Parameters<ChatContextRooms['addMember']>[0]): CommandIssued;
  removeMember(input: Parameters<ChatContextRooms['removeMember']>[0]): CommandIssued;
  close(input: Parameters<ChatContextRooms['close']>[0]): CommandIssued;
  postSystemEvent(
    input: Parameters<ChatContextRooms['postSystemEvent']>[0] & { messageId: Uuid },
  ): CommandIssued;
};

export const CHAT_CONTEXT_ROOM_COMMANDS: Token<ChatContextRoomCommands> = createToken(
  'CHAT_CONTEXT_ROOM_COMMANDS',
);

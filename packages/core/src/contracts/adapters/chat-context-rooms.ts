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
  /** Posts as the system author; allowed in a closed room. */
  postSystemEvent(input: {
    ref: string;
    code: SystemEventMetadata['code'];
    params?: SystemEventMetadata['params'];
    tx?: unknown;
  }): Promise<ChatContextRoomWrite<{ message: SystemChatMessage }>>;
};

export const CHAT_CONTEXT_ROOMS: Token<ChatContextRooms> = createToken('CHAT_CONTEXT_ROOMS');

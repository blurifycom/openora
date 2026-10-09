import { eq } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import {
  CHAT_SCOPES_COVERING_REACH,
  GLOBAL_CHAT_ROOM_ID,
  type ChatModerationRoomId,
  type ChatModerationScope,
  type ChatRoomReach,
  type Uuid,
} from '@openora/core/contracts';
import { chatRoom } from '../schema/index.js';
import {
  ChatAdminPrivateRoomModerationError,
  ChatRoomNotFoundError,
} from '../service/errors/chat-moderation.errors.js';

export type ModerationTarget = { scope: ChatModerationScope; roomId: Uuid | null };

export function roomReach(room: { slug: string; isPublic: boolean }): ChatRoomReach {
  if (room.slug === GLOBAL_CHAT_ROOM_ID) {
    return 'global';
  }
  return room.isPublic ? 'public' : 'private';
}

export function platformScopesFor(reach: ChatRoomReach): ChatModerationScope[] {
  return [...CHAT_SCOPES_COVERING_REACH[reach]];
}

// `validate` guards new restrictions only; lifting one must still reach missing, deleted or private rooms.
export async function resolveModerationTarget(
  db: DrizzleDb | DrizzleTx,
  roomId: ChatModerationRoomId,
  { validate }: { validate: boolean },
): Promise<ModerationTarget> {
  if (roomId === '__all' || roomId === '__all_public') {
    return { scope: roomId, roomId: null };
  }
  const [room] = await db
    .select({ slug: chatRoom.slug, isPublic: chatRoom.isPublic, deletedAt: chatRoom.deletedAt })
    .from(chatRoom)
    .where(
      roomId === GLOBAL_CHAT_ROOM_ID
        ? eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID)
        : eq(chatRoom.id, roomId),
    )
    .limit(1);
  const target: ModerationTarget =
    roomId === GLOBAL_CHAT_ROOM_ID || room?.slug === GLOBAL_CHAT_ROOM_ID
      ? { scope: GLOBAL_CHAT_ROOM_ID, roomId: null }
      : { scope: 'room', roomId };
  if (!validate || (roomId === GLOBAL_CHAT_ROOM_ID && !room)) {
    return target;
  }
  if (!room || room.deletedAt) {
    throw new ChatRoomNotFoundError(roomId);
  }
  if (!room.isPublic) {
    throw new ChatAdminPrivateRoomModerationError();
  }
  return target;
}

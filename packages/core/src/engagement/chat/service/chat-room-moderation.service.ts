import { and, eq } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import type { Uuid } from '@openora/core/contracts';
import { chatRoomMember } from '../schema/index.js';
import {
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
} from './errors/chat-moderation.errors.js';

/** When a moderation of `durationSeconds` lapses, counted from now; null is indefinite. */
export const expiryFrom = (durationSeconds: number | null) =>
  durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);

export async function findRoomMember(db: DrizzleDb | DrizzleTx, roomId: Uuid, userId: Uuid) {
  const [member] = await db
    .select({ role: chatRoomMember.role })
    .from(chatRoomMember)
    .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
    .limit(1);
  return member;
}

export function assertNotSelfModeration(moderatorId: Uuid, userId: Uuid) {
  if (moderatorId === userId) {
    throw new ChatRoomSelfModerationError();
  }
}

/**
 * The actor must moderate or own the room; with a target, only an owner may act on a fellow
 * moderator or the owner. Returns the actor's role.
 */
export async function assertRoomModerator(
  db: DrizzleDb | DrizzleTx,
  roomId: Uuid,
  actorId: Uuid,
  targetId?: Uuid,
) {
  const actor = await findRoomMember(db, roomId, actorId);
  if (!actor || (actor.role !== 'moderator' && actor.role !== 'owner')) {
    throw new ChatRoomNotModeratorError(roomId);
  }
  if (targetId) {
    const target = await findRoomMember(db, roomId, targetId);
    if (actor.role !== 'owner' && target && target.role !== 'member') {
      throw new ChatRoomNotModeratorError(roomId);
    }
  }
  return actor.role;
}

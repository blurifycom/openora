import { and, count, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@openora/core/server';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { chatMessage, chatRoom, chatRoomMember } from '../schema/index.js';

const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

type RoomRow = Pick<typeof chatRoom.$inferSelect, 'id' | 'slug'>;

export type AdminRoomStats = {
  memberCount: number | null;
  messageCount24h: number;
  lastMessageAt: Date | null;
};

// Literal, not bound parameters, so the planner can match the partial index on these rows.
const visiblePlayerMessage = sql`${chatMessage.type} = 'user' AND ${chatMessage.isDeleted} = false`;

function countMembers(db: DrizzleDb, roomIds: string[]) {
  if (roomIds.length === 0) {
    return Promise.resolve([]);
  }
  return db
    .select({ roomId: chatRoomMember.roomId, total: count() })
    .from(chatRoomMember)
    .where(and(inArray(chatRoomMember.roomId, roomIds), isNull(chatRoomMember.accountClosedAt)))
    .groupBy(chatRoomMember.roomId);
}

// Global-room messages are stored with a null room id.
function countRecentMessages(db: DrizzleDb, roomIds: string[], includesGlobal: boolean) {
  return db
    .select({ roomId: chatMessage.roomId, total: count() })
    .from(chatMessage)
    .where(
      and(
        or(
          roomIds.length > 0 ? inArray(chatMessage.roomId, roomIds) : undefined,
          includesGlobal ? isNull(chatMessage.roomId) : undefined,
        ),
        gte(chatMessage.createdAt, new Date(Date.now() - ACTIVITY_WINDOW_MS)),
        visiblePlayerMessage,
      ),
    )
    .groupBy(chatMessage.roomId);
}

// A LIMIT 1 backward index scan per room, not a max() over each room's whole history. The
// global branch filters on the outer row's slug, so it only scans for the global room.
function findLastMessages(db: DrizzleDb, roomIds: string[]) {
  const roomLatest = db
    .select({ createdAt: chatMessage.createdAt })
    .from(chatMessage)
    .where(and(eq(chatMessage.roomId, chatRoom.id), visiblePlayerMessage))
    .orderBy(desc(chatMessage.createdAt))
    .limit(1)
    .as('room_latest');
  const globalLatest = db
    .select({ createdAt: chatMessage.createdAt })
    .from(chatMessage)
    .where(
      and(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID), isNull(chatMessage.roomId), visiblePlayerMessage),
    )
    .orderBy(desc(chatMessage.createdAt))
    .limit(1)
    .as('global_latest');
  return db
    .select({
      roomId: chatRoom.id,
      lastMessageAt: sql`coalesce(${roomLatest.createdAt}, ${globalLatest.createdAt})`.mapWith(
        chatMessage.createdAt,
      ),
    })
    .from(chatRoom)
    .leftJoinLateral(roomLatest, sql`true`)
    .leftJoinLateral(globalLatest, sql`true`)
    .where(inArray(chatRoom.id, roomIds));
}

export async function withAdminRoomStats<T extends RoomRow>(
  db: DrizzleDb,
  rooms: readonly T[],
): Promise<(T & AdminRoomStats)[]> {
  if (rooms.length === 0) {
    return [];
  }
  const globalRoom = rooms.find((room) => room.slug === GLOBAL_CHAT_ROOM_ID);
  const roomIds = rooms.filter((room) => room !== globalRoom).map((room) => room.id);
  const [members, recent, latest] = await Promise.all([
    countMembers(db, roomIds),
    countRecentMessages(db, roomIds, globalRoom !== undefined),
    findLastMessages(
      db,
      rooms.map((room) => room.id),
    ),
  ]);
  const memberTotals = new Map(members.map((row) => [row.roomId, row.total]));
  const recentTotals = new Map(recent.map((row) => [row.roomId ?? globalRoom?.id, row.total]));
  const lastMessageAt = new Map(latest.map((row) => [row.roomId, row.lastMessageAt]));
  return rooms.map((room) => ({
    ...room,
    memberCount: room === globalRoom ? null : (memberTotals.get(room.id) ?? 0),
    messageCount24h: recentTotals.get(room.id) ?? 0,
    lastMessageAt: lastMessageAt.get(room.id) ?? null,
  }));
}

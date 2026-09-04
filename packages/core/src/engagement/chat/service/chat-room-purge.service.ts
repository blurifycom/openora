import { and, count, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import {
  DrizzleService,
  withAdvisoryXactLock,
  mapConcurrent,
  createLogger,
} from '@openora/core/server';
import type { EventBus } from '@openora/core/server';
import {
  chatChannel,
  type AuditWritePort,
  type RealtimeTransport,
  type Uuid,
} from '@openora/core/contracts';
import { chatMessage, chatMute, chatRoom, chatRoomMember } from '../schema/index.js';

const ROOM_REVOKE_CONCURRENCY = 10;

const logger = createLogger('chat');

export class ChatRoomPurgeService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly transport: RealtimeTransport,
    private readonly audit: AuditWritePort,
  ) {}

  async listDueRooms(limit: number): Promise<Uuid[]> {
    const due = await this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoom)
      .where(
        and(
          eq(chatRoom.isPublic, false),
          isNull(chatRoom.deletedAt),
          isNotNull(chatRoom.scheduledDeletionAt),
          lte(chatRoom.scheduledDeletionAt, new Date()),
        ),
      )
      .orderBy(chatRoom.scheduledDeletionAt)
      .limit(limit);
    return due.map((room) => room.id);
  }

  async purgeRoom(roomId: Uuid) {
    const result = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        const [room] = await t
          .select({ id: chatRoom.id })
          .from(chatRoom)
          .where(
            and(
              eq(chatRoom.id, roomId),
              eq(chatRoom.isPublic, false),
              isNull(chatRoom.deletedAt),
              isNotNull(chatRoom.scheduledDeletionAt),
              lte(chatRoom.scheduledDeletionAt, new Date()),
            ),
          )
          .limit(1);
        if (!room) {
          return null;
        }
        const members = await t
          .select({ userId: chatRoomMember.userId })
          .from(chatRoomMember)
          .where(eq(chatRoomMember.roomId, roomId));
        const [messages] = await t
          .select({ value: count() })
          .from(chatMessage)
          .where(eq(chatMessage.roomId, roomId));
        const messageCount = messages?.value ?? 0;
        await t.delete(chatMute).where(eq(chatMute.roomId, roomId));
        await this.audit.recordInTransaction(t, {
          actorType: 'system',
          action: 'chat.private_room.purged',
          resourceType: 'chat_room',
          resourceId: roomId,
          after: { messageCount },
        });
        await t.delete(chatRoom).where(eq(chatRoom.id, roomId));
        return { memberIds: members.map((m) => m.userId), messageCount };
      }),
    );
    if (!result) {
      return false;
    }
    this.events.emit('chat.private_room.purged', {
      roomId,
      messageCount: result.messageCount,
    });
    await mapConcurrent(result.memberIds, ROOM_REVOKE_CONCURRENCY, async (memberId) => {
      try {
        await this.transport.revokeUserFromChannel?.(memberId, chatChannel(roomId));
      } catch (err: unknown) {
        logger.error({ err, roomId, memberId }, 'chat room channel revoke failed');
      }
    });
    return true;
  }
}

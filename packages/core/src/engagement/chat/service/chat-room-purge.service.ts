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

/**
 * Hard-deletes private rooms whose owner-less countdown has run out. This is the only
 * hard delete in the chat domain - everywhere else a room is soft-deleted via
 * `chatRoom.deletedAt` - so the selection guard is the whole safety story: a room is
 * purged only when it is private AND carries a deadline AND that deadline has passed.
 * `chatRoom.scheduledDeletionAt` is written in exactly one place
 * (`ChatRoomMembershipService.handleAccountClosed`) and never rewritten.
 *
 * Split in two on purpose. A daily cron calls {@link listDueRooms} and enqueues one job
 * per room; each job calls {@link purgeRoom} for that room alone. So a room that fails to
 * delete retries on its own schedule instead of waiting for tomorrow's tick, and it cannot
 * block the rooms behind it in the batch.
 */
export class ChatRoomPurgeService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly transport: RealtimeTransport,
    private readonly audit: AuditWritePort,
  ) {}

  /**
   * The rooms a tick should hand out, newest deadline last. `limit` bounds one tick's
   * fan-out: after downtime the backlog can be arbitrarily long, and a deadline that has
   * already passed does not get worse by being purged on the next tick instead of this one.
   */
  async listDueRooms(limit: number): Promise<Uuid[]> {
    const due = await this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoom)
      .where(
        and(
          eq(chatRoom.isPublic, false),
          isNull(chatRoom.deletedAt),
          // `isNotNull` is redundant next to `lte` in SQL, but it is the invariant this
          // job exists to respect - a room with no deadline is never eligible - so it is
          // stated, not implied.
          isNotNull(chatRoom.scheduledDeletionAt),
          lte(chatRoom.scheduledDeletionAt, new Date()),
        ),
      )
      .orderBy(chatRoom.scheduledDeletionAt)
      .limit(limit);
    return due.map((room) => room.id);
  }

  /**
   * Purges one room. Idempotent: a room already gone, or one that stopped qualifying,
   * returns false and writes nothing, so a retried job is safe.
   */
  async purgeRoom(roomId: Uuid) {
    // Same lock join/leave/handleAccountClosed take, so a member joining concurrently
    // either lands before the roster snapshot (and gets revoked) or after the delete
    // (and hits a room that no longer exists).
    const result = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        // Re-read the full guard under the lock: the row was selected outside it, and a
        // hard delete must never run on a room that stopped qualifying in between.
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
        // Counted before the delete because the rows are about to stop existing, and the
        // count is the one quantity the audit record carries about what was destroyed.
        const [messages] = await t
          .select({ value: count() })
          .from(chatMessage)
          .where(eq(chatMessage.roomId, roomId));
        const messageCount = messages?.value ?? 0;
        // chat_mute has no foreign key at all - its roomId is a bare nullable column
        // (null = global chat) - so its rows are deleted here to stop them outliving the
        // room as orphans. Everything else hangs off chat_room with `onDelete: cascade`
        // and goes with the room itself: chat_message, chat_platform_ban, chat_room_member,
        // _rule, _configuration, _ban, _remove, and chat_room_mute, which despite the name
        // is a different table from chat_mute.
        await t.delete(chatMute).where(eq(chatMute.roomId, roomId));
        // The audit record joins the delete's own transaction. After a hard delete this
        // record is the room's only surviving trace, and a post-commit write would lose it
        // outright if the process died in between - the one case where the trace matters
        // most. Written before the delete so a failure to record fails the purge.
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
    // Best-effort fan-out for overlays and clients; the audit record above is already
    // durable, so nothing here can lose the room's trace.
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

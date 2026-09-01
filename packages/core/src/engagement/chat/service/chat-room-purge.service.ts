import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import {
  DrizzleService,
  withAdvisoryXactLock,
  mapConcurrent,
  createLogger,
} from '@openora/core/server';
import type { EventBus } from '@openora/core/server';
import { chatChannel, type RealtimeTransport, type Uuid } from '@openora/core/contracts';
import {
  chatMessage,
  chatMute,
  chatPlatformBan,
  chatRoom,
  chatRoomMember,
} from '../schema/index.js';

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
 * Driven by a daily cron rather than a per-room timer: the deadline has day granularity,
 * so a finer tick buys nothing and a missed run just deletes a day late.
 */
export class ChatRoomPurgeService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly transport: RealtimeTransport,
  ) {}

  /** One pass over the due rooms. Idempotent: a purged room stops matching the scan. */
  async runCycle() {
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
      );
    let purged = 0;
    for (const { id } of due) {
      if (await this.purgeRoom(id)) {
        purged += 1;
      }
    }
    return { purged } as const;
  }

  private async purgeRoom(roomId: Uuid) {
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
        // chat_message, chat_platform_ban and chat_mute point at chat_room without a
        // cascade, so they go first or the room delete trips their foreign key. Everything
        // else (chat_room_member, _rule, _configuration, _ban, _mute, _remove) cascades.
        const messages = await t
          .delete(chatMessage)
          .where(eq(chatMessage.roomId, roomId))
          .returning({ id: chatMessage.id });
        await t.delete(chatPlatformBan).where(eq(chatPlatformBan.roomId, roomId));
        await t.delete(chatMute).where(eq(chatMute.roomId, roomId));
        await t.delete(chatRoom).where(eq(chatRoom.id, roomId));
        return { memberIds: members.map((m) => m.userId), messageCount: messages.length };
      }),
    );
    if (!result) {
      return false;
    }
    // Emitted before the realtime cleanup: this event is what writes the audit record, and
    // after a hard delete that record is the room's only surviving trace - it must not go
    // missing because a transport happened to be down.
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

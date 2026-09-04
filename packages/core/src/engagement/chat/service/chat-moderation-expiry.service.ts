import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { DrizzleService } from '@openora/core/server';
import type { AuditAction, AuditWritePort, Uuid } from '@openora/core/contracts';
import { chatMute, chatPlatformBan } from '../schema/index.js';

/** Rows considered per table per pass. A backlog just drains over the next few ticks. */
const EXPIRY_SWEEP_BATCH_SIZE = 500;

/**
 * Writes the audit entry nothing else writes: a timed chat mute or platform ban lapsing
 * on its own. Expiry here is a read-time predicate, so no actor-initiated path records
 * it and the trail would otherwise show moderation start and never end.
 *
 * Changes no enforcement; `expiryRecordedAt` is read nowhere but here.
 */
export class ChatModerationExpiryService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  /** One pass over both tables. Idempotent: a recorded row stops matching the scan. */
  async sweep() {
    const mutes = await this.recordLapsed(chatMute, 'chat.mute.expired', 'chat_mute');
    const bans = await this.recordLapsed(
      chatPlatformBan,
      'chat.platform_ban.expired',
      'chat_platform_ban',
    );
    return { mutes, bans } as const;
  }

  private async recordLapsed(
    table: typeof chatMute | typeof chatPlatformBan,
    action: AuditAction,
    resourceType: string,
  ) {
    const now = new Date();
    const due = await this.drizzle.db
      .select({
        id: table.id,
        userId: table.userId,
        roomId: table.roomId,
        scope: table.scope,
        expiresAt: table.expiresAt,
      })
      .from(table)
      .where(
        and(
          isNull(table.liftedAt),
          isNotNull(table.expiresAt),
          lte(table.expiresAt, now),
          isNull(table.expiryRecordedAt),
        ),
      )
      // Oldest lapse first, so the batch cap cannot starve a row behind newer ones.
      .orderBy(asc(table.expiresAt))
      .limit(EXPIRY_SWEEP_BATCH_SIZE);

    let recorded = 0;
    for (const row of due) {
      if (await this.recordOne(table, action, resourceType, row)) {
        recorded += 1;
      }
    }
    return recorded;
  }

  private async recordOne(
    table: typeof chatMute | typeof chatPlatformBan,
    action: AuditAction,
    resourceType: string,
    row: {
      id: Uuid;
      userId: Uuid;
      roomId: Uuid | null;
      scope: string;
      expiresAt: Date | null;
    },
  ) {
    return this.drizzle.db.transaction(async (tx) => {
      // The claim re-applies the scan's `expiryRecordedAt IS NULL` guard as an UPDATE:
      // two workers can select the same row, but only one UPDATE returns it. That is
      // what makes "exactly one entry per lapse" hold rather than "usually one".
      const claimed = await tx
        .update(table)
        .set({ expiryRecordedAt: new Date() })
        .where(and(eq(table.id, row.id), isNull(table.expiryRecordedAt)))
        .returning({ id: table.id });
      if (claimed.length === 0) {
        return false;
      }
      await this.audit.recordInTransaction(tx, {
        actorId: null,
        actorType: 'system',
        action,
        resourceType,
        resourceId: row.id,
        // The row's own expiresAt, not the sweep's clock: the entry has to state when
        // moderation stopped applying, not when cron got round to noticing.
        before: {
          userId: row.userId,
          roomId: row.roomId,
          scope: row.scope,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
      });
      return true;
    });
  }
}

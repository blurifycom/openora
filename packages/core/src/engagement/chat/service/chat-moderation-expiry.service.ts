import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { DrizzleService } from '@openora/core/server';
import type { AuditAction, AuditWritePort, Uuid } from '@openora/core/contracts';
import { chatMute, chatPlatformBan } from '../schema/index.js';

/** Rows considered per table per pass. A backlog just drains over the next few ticks. */
const EXPIRY_SWEEP_BATCH_SIZE = 500;

/**
 * Writes the audit entry nothing else writes: the moment a timed chat mute or platform
 * ban stops applying on its own.
 *
 * Expiry in this domain is a read-time predicate - `assertCanSend`, `listMutes` and
 * `listBans` all compare `expiresAt` to now - so a lapse is not an event anybody
 * observes, and the actor-initiated paths only ever record `created` and `lifted`. An
 * auditor reading the trail could see a ban start and never see it end. This sweep is
 * what closes that gap; it changes no enforcement, and `expiryRecordedAt` is read
 * nowhere but here.
 *
 * Cron-driven rather than timer-per-row: the trail only needs to say *when* moderation
 * lapsed, and the row's own `expiresAt` carries that regardless of when the sweep runs.
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
          // Redundant beside `lte` in SQL, but it is the invariant this job exists to
          // respect: a permanent entry never lapses, so it is stated, not implied.
          isNotNull(table.expiresAt),
          lte(table.expiresAt, now),
          isNull(table.expiryRecordedAt),
        ),
      )
      // Oldest lapse first, so a backlog drains in the order things actually expired and
      // the batch cap cannot leave one row starved behind newer ones.
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
      // The claim *is* the `expiryRecordedAt IS NULL` guard, re-applied as an UPDATE
      // rather than trusted from the scan above: two workers can select the same row,
      // but only one UPDATE returns it, and the loser writes nothing. That is what makes
      // "exactly one audit entry per lapse" hold rather than "usually one".
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
        // `before` carries the row's real expiresAt, not the sweep's clock: the entry has
        // to state when the moderation actually stopped applying, which is the instant
        // the player could post again - not whenever the cron got round to noticing.
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

import { and, asc, eq, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DrizzleService, type DrizzleTx } from '@openora/core/server';
import type { AuditAction, AuditWritePort, Uuid } from '@openora/core/contracts';
import {
  chatMute,
  chatPlatformBan,
  chatPlayerCooldown,
  chatRoomBan,
  chatRoomMute,
} from '../schema/index.js';

type ExpiringTable = typeof chatMute | typeof chatPlatformBan | typeof chatPlayerCooldown;

const EXPIRY_SWEEP_BATCH_SIZE = 500;

export async function retireLapsedRows(
  tx: DrizzleTx,
  table: ExpiringTable | typeof chatRoomBan | typeof chatRoomMute,
  active: SQL | undefined,
  now: Date,
) {
  await tx
    .update(table)
    .set({ liftedAt: sql`${table.expiresAt}` })
    .where(and(active, isNull(table.liftedAt), lte(table.expiresAt, now)));
}

export class ChatModerationExpiryService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async sweep() {
    const mutes = await this.recordLapsed(chatMute, 'chat.mute.expired', 'chat_mute');
    const bans = await this.recordLapsed(
      chatPlatformBan,
      'chat.platform_ban.expired',
      'chat_platform_ban',
    );
    const cooldowns = await this.recordLapsed(
      chatPlayerCooldown,
      'chat.cooldown.expired',
      'chat_player_cooldown',
      { cooldownSeconds: chatPlayerCooldown.cooldownSeconds },
    );
    return { mutes, bans, cooldowns } as const;
  }

  private async recordLapsed(
    table: ExpiringTable,
    action: AuditAction,
    resourceType: string,
    details: Record<string, AnyPgColumn> = {},
  ) {
    const now = new Date();
    const due = await this.drizzle.db
      .select({
        ...details,
        id: table.id,
        userId: table.userId,
        roomId: table.roomId,
        scope: table.scope,
        reason: table.reason,
        expiresAt: table.expiresAt,
      })
      .from(table)
      .where(
        and(
          or(isNull(table.liftedAt), eq(table.liftedAt, table.expiresAt)),
          isNotNull(table.expiresAt),
          lte(table.expiresAt, now),
          isNull(table.expiryRecordedAt),
        ),
      )
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
    table: ExpiringTable,
    action: AuditAction,
    resourceType: string,
    {
      id,
      expiresAt,
      ...before
    }: {
      id: Uuid;
      userId: Uuid;
      roomId: Uuid | null;
      scope: string;
      reason: string;
      expiresAt: Date | null;
    },
  ) {
    return this.drizzle.db.transaction(async (tx) => {
      const claimed = await tx
        .update(table)
        .set({ expiryRecordedAt: new Date() })
        .where(
          and(
            eq(table.id, id),
            or(isNull(table.liftedAt), eq(table.liftedAt, table.expiresAt)),
            isNull(table.expiryRecordedAt),
          ),
        )
        .returning({ id: table.id });
      if (claimed.length === 0) {
        return false;
      }
      await this.audit.recordInTransaction(tx, {
        actorId: null,
        actorType: 'system',
        action,
        resourceType,
        resourceId: id,
        before: { ...before, expiresAt: expiresAt?.toISOString() ?? null },
      });
      return true;
    });
  }
}

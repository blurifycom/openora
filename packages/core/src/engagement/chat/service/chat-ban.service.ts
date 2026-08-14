import { and, desc, eq, isNull } from 'drizzle-orm';
import { DrizzleService, serializeRow } from '@openora/core/server';
import type { AuditWritePort, ClientMeta, RealtimeTransport, Uuid } from '@openora/core/contracts';
import { chatPlatformBan } from '../schema/index.js';

export class ChatBanService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
    private readonly transport?: RealtimeTransport,
  ) {}

  async ban({
    userId,
    reason,
    actorId,
    ip,
    userAgent,
  }: { userId: Uuid; reason: string; actorId: Uuid } & ClientMeta) {
    const [created] = await this.drizzle.db
      .insert(chatPlatformBan)
      .values({ userId, bannedBy: actorId, reason })
      .onConflictDoNothing()
      .returning();
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.platform_ban.created',
      resourceType: 'chat_platform_ban',
      resourceId: created?.id ?? null,
      after: { userId, reason },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    await this.transport?.revokeClient?.(userId);
    return { success: true } as const;
  }

  async unban({ userId, actorId, ip, userAgent }: { userId: Uuid; actorId: Uuid } & ClientMeta) {
    const [lifted] = await this.drizzle.db
      .update(chatPlatformBan)
      .set({ liftedAt: new Date(), liftedBy: actorId })
      .where(and(eq(chatPlatformBan.userId, userId), isNull(chatPlatformBan.liftedAt)))
      .returning({ id: chatPlatformBan.id });
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.platform_ban.lifted',
      resourceType: 'chat_platform_ban',
      resourceId: lifted?.id ?? null,
      after: { userId },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return { success: true } as const;
  }

  async listBans(userId?: Uuid) {
    const rows = await this.drizzle.db
      .select({
        id: chatPlatformBan.id,
        userId: chatPlatformBan.userId,
        reason: chatPlatformBan.reason,
        createdAt: chatPlatformBan.createdAt,
        liftedAt: chatPlatformBan.liftedAt,
      })
      .from(chatPlatformBan)
      .where(
        and(
          isNull(chatPlatformBan.liftedAt),
          userId ? eq(chatPlatformBan.userId, userId) : undefined,
        ),
      )
      .orderBy(desc(chatPlatformBan.createdAt));
    return rows.map((row) => serializeRow(row, { dateFields: ['createdAt', 'liftedAt'] }));
  }
}

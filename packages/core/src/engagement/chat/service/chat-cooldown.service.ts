import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { DrizzleService, withAdvisoryXactLock } from '@openora/core/server';
import type {
  AuditWritePort,
  ChatCooldownEntry,
  ChatModerationRoomId,
  ChatModerationScope,
  ClientMeta,
  Uuid,
} from '@openora/core/contracts';
import { chatPlayerCooldown } from '../schema/index.js';
import { resolveModerationTarget } from '../moderation/index.js';
import { retireLapsedRows } from './chat-moderation-expiry.service.js';

export class ChatCooldownService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async setCooldown({
    userId,
    roomId,
    cooldownSeconds,
    durationSeconds,
    reason,
    actorId,
    ip,
    userAgent,
  }: {
    userId: Uuid;
    roomId: ChatModerationRoomId;
    cooldownSeconds: number;
    durationSeconds: number | null;
    reason: string;
    actorId: Uuid;
  } & ClientMeta) {
    const target = await resolveModerationTarget(this.drizzle.db, roomId, { validate: true });
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-cooldown:${userId}`, async () => {
        const now = new Date();
        const targetCooldowns = and(
          eq(chatPlayerCooldown.userId, userId),
          eq(chatPlayerCooldown.scope, target.scope),
          target.roomId
            ? eq(chatPlayerCooldown.roomId, target.roomId)
            : isNull(chatPlayerCooldown.roomId),
          isNull(chatPlayerCooldown.liftedAt),
        );
        await retireLapsedRows(t, chatPlayerCooldown, targetCooldowns, now);
        const [previous] = await t
          .update(chatPlayerCooldown)
          .set({ liftedAt: now, liftedBy: actorId })
          .where(targetCooldowns)
          .returning({
            id: chatPlayerCooldown.id,
            cooldownSeconds: chatPlayerCooldown.cooldownSeconds,
            reason: chatPlayerCooldown.reason,
            expiresAt: chatPlayerCooldown.expiresAt,
          });
        const [created] = await t
          .insert(chatPlayerCooldown)
          .values({
            userId,
            roomId: target.roomId,
            scope: target.scope,
            cooldownSeconds,
            reason,
            createdBy: actorId,
            expiresAt,
          })
          .returning({ id: chatPlayerCooldown.id });
        await this.audit.recordInTransaction(t, {
          actorId,
          actorType: 'admin',
          action: 'chat.cooldown.created',
          resourceType: 'chat_player_cooldown',
          resourceId: created.id,
          before: previous
            ? {
                cooldownId: previous.id,
                cooldownSeconds: previous.cooldownSeconds,
                reason: previous.reason,
                expiresAt: previous.expiresAt?.toISOString() ?? null,
              }
            : null,
          after: {
            userId,
            scope: target.scope,
            roomId: target.roomId,
            cooldownSeconds,
            reason,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }),
    );
    return { success: true } as const;
  }

  async liftCooldown({
    userId,
    roomId,
    actorId,
    ip,
    userAgent,
  }: { userId: Uuid; roomId: ChatModerationRoomId; actorId: Uuid } & ClientMeta) {
    const { scope, roomId: concreteRoomId } = await resolveModerationTarget(
      this.drizzle.db,
      roomId,
      { validate: false },
    );
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-cooldown:${userId}`, async () => {
        const liftedAt = new Date();
        const [lifted] = await t
          .update(chatPlayerCooldown)
          .set({ liftedAt, liftedBy: actorId })
          .where(
            and(
              eq(chatPlayerCooldown.userId, userId),
              or(isNull(chatPlayerCooldown.expiresAt), gt(chatPlayerCooldown.expiresAt, liftedAt)),
              eq(chatPlayerCooldown.scope, scope),
              concreteRoomId === null
                ? isNull(chatPlayerCooldown.roomId)
                : eq(chatPlayerCooldown.roomId, concreteRoomId),
              isNull(chatPlayerCooldown.liftedAt),
            ),
          )
          .returning({
            id: chatPlayerCooldown.id,
            cooldownSeconds: chatPlayerCooldown.cooldownSeconds,
            reason: chatPlayerCooldown.reason,
            expiresAt: chatPlayerCooldown.expiresAt,
          });
        if (!lifted) {
          return;
        }
        await this.audit.recordInTransaction(t, {
          actorId,
          actorType: 'admin',
          action: 'chat.cooldown.lifted',
          resourceType: 'chat_player_cooldown',
          resourceId: lifted.id,
          before: {
            cooldownSeconds: lifted.cooldownSeconds,
            reason: lifted.reason,
            expiresAt: lifted.expiresAt?.toISOString() ?? null,
          },
          after: { userId, scope, roomId: concreteRoomId, liftedAt: liftedAt.toISOString() },
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }),
    );
    return { success: true } as const;
  }

  async listCooldowns(userIds?: readonly Uuid[]): Promise<ChatCooldownEntry[]> {
    const rows = await this.drizzle.db
      .select({
        id: chatPlayerCooldown.id,
        userId: chatPlayerCooldown.userId,
        roomId: chatPlayerCooldown.roomId,
        scope: chatPlayerCooldown.scope,
        cooldownSeconds: chatPlayerCooldown.cooldownSeconds,
        reason: chatPlayerCooldown.reason,
        createdBy: chatPlayerCooldown.createdBy,
        createdAt: chatPlayerCooldown.createdAt,
        expiresAt: chatPlayerCooldown.expiresAt,
      })
      .from(chatPlayerCooldown)
      .where(
        and(
          isNull(chatPlayerCooldown.liftedAt),
          or(isNull(chatPlayerCooldown.expiresAt), gt(chatPlayerCooldown.expiresAt, new Date())),
          userIds ? inArray(chatPlayerCooldown.userId, userIds) : undefined,
        ),
      )
      .orderBy(desc(chatPlayerCooldown.createdAt));
    return rows.map((row) => ({
      ...row,
      scope: row.scope as ChatModerationScope,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));
  }
}

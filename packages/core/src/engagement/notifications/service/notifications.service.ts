import {
  type EventBus,
  makeNotFoundError,
  makeOwnershipError,
  createDomainError,
  assertOwnership,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
} from '@openora/core/server';
import { eq, and, isNull, asc, desc, count, lt } from 'drizzle-orm';
import type { PaginationOptions, User } from '@openora/core/contracts';
import { notification } from '../schema/index.js';
import type { CreateNotificationInput, NotificationSortBy } from '../contract/index.js';

export const NotificationNotFoundError = makeNotFoundError('Notification');

export const NotificationOwnershipError = makeOwnershipError('Notification');

const NotificationInsertFailedError = createDomainError(
  'NotificationInsertFailedError',
  () => 'Notification insert did not return a row',
);

export class NotificationsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async create(input: CreateNotificationInput) {
    const record = findOneOrThrow(
      await this.drizzle.db
        .insert(notification)
        .values({ ...input, data: input.data ?? null })
        .returning(),
      new NotificationInsertFailedError(),
    );
    this.events.emit('notifications.created', {
      notificationId: record.id,
      userId: input.userId,
    });
    return record;
  }

  async listForUser({
    userId,
    page,
    limit,
    sortOrder,
  }: PaginationOptions<{ userId: User['id'] }, NotificationSortBy>) {
    const dir = sortOrder === 'asc' ? asc : desc;
    const where = eq(notification.userId, userId);
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(notification)
        .where(where)
        .orderBy(dir(notification.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(notification).where(where),
    ]);
    return { items: rows, total: Number(n), page, limit };
  }

  async unreadCount(userId: User['id']) {
    const [{ n }] = await this.drizzle.db
      .select({ n: count() })
      .from(notification)
      .where(and(eq(notification.userId, userId), isNull(notification.readAt)));
    return Number(n);
  }

  async markRead(id: string, userId: User['id']) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(notification).where(eq(notification.id, id)),
      new NotificationNotFoundError(id),
    );
    assertOwnership(record.userId, userId, new NotificationOwnershipError());
    const updated = findOneOrThrow(
      await this.drizzle.db
        .update(notification)
        .set({ readAt: new Date() })
        .where(eq(notification.id, id))
        .returning(),
      new NotificationNotFoundError(id),
    );
    return updated;
  }

  async markAllRead(userId: User['id']) {
    const rows = await this.drizzle.db
      .update(notification)
      .set({ readAt: new Date() })
      .where(and(eq(notification.userId, userId), isNull(notification.readAt)))
      .returning({ id: notification.id });
    return { count: rows.length };
  }

  // Unconditional on age (read or unread), not gated on readAt - deletes anything past
  // the retention window regardless of read state.
  async purgeExpired(retentionDays: number) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const rows = await this.drizzle.db
      .delete(notification)
      .where(lt(notification.createdAt, cutoff))
      .returning({ id: notification.id });
    return { count: rows.length };
  }
}

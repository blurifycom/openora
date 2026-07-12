import {
  type EventBus,
  makeNotFoundError,
  makeOwnershipError,
  createDomainError,
  assertOwnership,
  DrizzleService,
  findOneOrThrow,
} from '@openora/core/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import type { User } from '@openora/core/contracts';
import { notification } from '../schema/index.js';
import type { CreateNotificationInput } from '../contract/index.js';

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
        .values({ ...input })
        .returning(),
      new NotificationInsertFailedError(),
    );
    this.events.emit('notifications.created', {
      notificationId: record.id,
      userId: input.userId,
    });
    return record;
  }

  async listForUser(userId: User['id']) {
    return this.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.userId, userId))
      .orderBy(desc(notification.createdAt))
      .limit(50);
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
}

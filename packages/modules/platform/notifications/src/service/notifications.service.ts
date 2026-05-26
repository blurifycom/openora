import { Injectable, Inject } from '@nestjs/common';
import { type EventBus, EVENT_BUS, createDomainError } from '@oss/core';
import { DrizzleService } from '@oss/db';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { notification } from '../schema/index.js';
import type { CreateNotificationInput } from '../schemas/index.js';

export const NotificationNotFoundError = createDomainError(
  'NotificationNotFoundError',
  (id: string) => `Notification not found: ${id}`,
);

export const NotificationOwnershipError = createDomainError(
  'NotificationOwnershipError',
  (id: string) => `Notification ${id} does not belong to the requesting user`,
);

@Injectable()
export class NotificationsService {
  constructor(
    private readonly drizzle: DrizzleService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async create(input: CreateNotificationInput) {
    const [record] = await this.drizzle.db
      .insert(notification)
      .values({
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
      })
      .returning();
    this.events.emit('notifications.created', {
      notificationId: record!.id,
      userId: input.userId,
    });
    return record!;
  }

  async listForUser(userId: string) {
    return this.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.userId, userId))
      .orderBy(desc(notification.createdAt))
      .limit(50);
  }

  async markRead(id: string, userId: string) {
    const [record] = await this.drizzle.db
      .select()
      .from(notification)
      .where(eq(notification.id, id));
    if (!record) {
      throw new NotificationNotFoundError(id);
    }
    if (record.userId !== userId) {
      throw new NotificationOwnershipError(id);
    }
    const [updated] = await this.drizzle.db
      .update(notification)
      .set({ readAt: new Date() })
      .where(eq(notification.id, id))
      .returning();
    return updated!;
  }

  async markAllRead(userId: string): Promise<{ count: number }> {
    const rows = await this.drizzle.db
      .update(notification)
      .set({ readAt: new Date() })
      .where(and(eq(notification.userId, userId), isNull(notification.readAt)))
      .returning({ id: notification.id });
    return { count: rows.length };
  }
}

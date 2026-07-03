import {
  type EventBus,
  makeNotFoundError,
  makeOwnershipError,
  assertOwnership,
  DrizzleService,
  findOneOrThrow,
} from '@blurifycom/core/server';
import { eq, and, isNull, desc } from 'drizzle-orm';
import * as z from 'zod';
import { UuidSchema } from '@blurifycom/core/contracts';
import { notification } from '../schema/index.js';

// Internal-only - fed by domain-event handlers in plugin.ts, not a wire route.
const CreateNotificationInputSchema = z.object({
  userId: UuidSchema,
  type: z.string(),
  title: z.string(),
  body: z.string(),
});
export type CreateNotificationInput = z.infer<typeof CreateNotificationInputSchema>;

export const NotificationNotFoundError = makeNotFoundError('Notification');

export const NotificationOwnershipError = makeOwnershipError('Notification');

export class NotificationsService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
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
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(notification).where(eq(notification.id, id)),
      new NotificationNotFoundError(id),
    );
    assertOwnership(record.userId, userId, new NotificationOwnershipError());
    const [updated] = await this.drizzle.db
      .update(notification)
      .set({ readAt: new Date() })
      .where(eq(notification.id, id))
      .returning();
    return updated!;
  }

  async markAllRead(userId: string) {
    const rows = await this.drizzle.db
      .update(notification)
      .set({ readAt: new Date() })
      .where(and(eq(notification.userId, userId), isNull(notification.readAt)))
      .returning({ id: notification.id });
    return { count: rows.length };
  }
}

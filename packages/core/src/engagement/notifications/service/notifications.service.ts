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

/**
 * `chat.rain.distributed` carries only the pooled `totalAmount`, not each
 * recipient's own share - the split is always exact (social-transfers pays the
 * same fixed per-recipient amount to every selected recipient, floored in SQL,
 * and `totalAmount` IS `perRecipient * recipients.length` - see
 * `engagement/social-transfers/AGENTS.md` "Rain has a remainder"), so this
 * recovers the per-recipient share without a payload version bump. BigInt
 * minor-unit division keeps it exact; float division could render a value the
 * player never actually received.
 */
export function perRecipientAmount(totalAmount: string, recipientCount: number): string {
  const [whole, fraction = ''] = totalAmount.split('.');
  const scale = fraction.length;
  const totalMinor = BigInt(`${whole}${fraction}`);
  const perMinor = totalMinor / BigInt(recipientCount);
  const digits = perMinor.toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  return scale > 0 ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
}

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

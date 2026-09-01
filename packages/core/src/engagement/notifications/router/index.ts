import { implement } from '@orpc/server';
import {
  createEventStreamGenerator,
  getUserId,
  mapErrors,
  type OssContext,
} from '@openora/core/server';
import type { RealtimeTransport, User } from '@openora/core/contracts';
import {
  notificationsContract,
  NotificationTypeSchema,
  NotificationDataSchema,
  type Notification,
} from '../contract/index.js';
import type { Notification as NotificationRow } from '../schema/index.js';
import {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from '../service/notifications.service.js';

export function notificationsChannel(userId: User['id']): string {
  return `notifications:${userId}`;
}

export function toNotificationDto(row: NotificationRow): Notification | null {
  const type = NotificationTypeSchema.safeParse(row.type);
  if (!type.success) {
    return null;
  }
  const data =
    row.data === null || row.data === undefined ? null : NotificationDataSchema.safeParse(row.data);
  if (data && !data.success) {
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    type: type.data,
    title: row.title,
    body: row.body,
    data: data ? data.data : null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createNotificationStream(
  realtime: RealtimeTransport,
  userId: User['id'],
  signal: AbortSignal | undefined,
): AsyncGenerator<Notification> {
  return createEventStreamGenerator(
    (push) => realtime.subscribe<Notification>(notificationsChannel(userId), push),
    { signal },
  );
}

export function createNotificationsRouter({
  notifications,
  realtime,
}: {
  notifications: NotificationsService;
  realtime: RealtimeTransport;
}) {
  const os = implement(notificationsContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(({ input, context }) =>
      notifications.listForUser({ ...input, userId: getUserId(context) }).then((page) => ({
        ...page,
        items: page.items.flatMap((row) => {
          const dto = toNotificationDto(row);
          return dto ? [dto] : [];
        }),
      })),
    ),

    unreadCount: os.unreadCount.handler(({ context }) =>
      notifications.unreadCount(getUserId(context)).then((count) => ({ count })),
    ),

    stream: os.stream.handler(({ signal, context }) =>
      createNotificationStream(realtime, getUserId(context), signal),
    ),

    markRead: os.markRead.handler(async ({ input, context }) => {
      await mapErrors(
        { NOT_FOUND: NotificationNotFoundError, FORBIDDEN: NotificationOwnershipError },
        () => notifications.markRead(input.id, getUserId(context)),
      );
      return { success: true as const };
    }),

    markAllRead: os.markAllRead.handler(({ context }) =>
      notifications.markAllRead(getUserId(context)),
    ),
  });
}

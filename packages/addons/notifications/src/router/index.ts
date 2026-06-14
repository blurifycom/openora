import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@oss/core';
import { notificationsContract } from '../contract/index.js';
import {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from '../service/notifications.service.js';

export function createNotificationsRouter(notifications: NotificationsService) {
  const os = implement(notificationsContract).$context<OssContext>();

  return os.router({
    list: os.list.handler(({ context }) =>
      notifications.listForUser(getUserId(context)).then((items) =>
        items.map((n) => ({
          ...n,
          readAt: n.readAt ? n.readAt.toISOString() : null,
          createdAt: n.createdAt.toISOString(),
        })),
      ),
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

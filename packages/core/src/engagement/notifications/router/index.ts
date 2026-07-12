import { implement } from '@orpc/server';
import { getUserId, mapErrors, type OssContext } from '@openora/core/server';
import { notificationsContract, NotificationTypeSchema } from '../contract/index.js';
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
        items.flatMap((n) => {
          const type = NotificationTypeSchema.safeParse(n.type);
          if (!type.success) {
            return [];
          }
          return [
            {
              ...n,
              type: type.data,
              readAt: n.readAt ? n.readAt.toISOString() : null,
              createdAt: n.createdAt.toISOString(),
            },
          ];
        }),
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

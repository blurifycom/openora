import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { getUserId, mapErrors } from '@oss/core';
import { notificationsContract } from '@oss/orpc-contract/notifications';
import {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from '../service/notifications.service.js';

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Implement(notificationsContract)
  notificationsRouter() {
    return {
      list: implement(notificationsContract.list).handler(({ context }) =>
        this.notifications.listForUser(getUserId(context)).then((items) =>
          items.map((n) => ({
            ...n,
            readAt: n.readAt ? n.readAt.toISOString() : null,
            createdAt: n.createdAt.toISOString(),
          })),
        ),
      ),

      markRead: implement(notificationsContract.markRead).handler(async ({ input, context }) => {
        await mapErrors(
          { NOT_FOUND: NotificationNotFoundError, FORBIDDEN: NotificationOwnershipError },
          () => this.notifications.markRead(input.id, getUserId(context)),
        );
        return { success: true as const };
      }),

      markAllRead: implement(notificationsContract.markAllRead).handler(({ context }) =>
        this.notifications.markAllRead(getUserId(context)),
      ),
    };
  }
}

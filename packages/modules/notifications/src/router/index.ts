import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { notificationsContract } from '@oss/orpc-contract/notifications';
import {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from '../service/notifications.service.js';
import type { Request } from 'express';
import { ORPCError } from '@orpc/server';

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Implement(notificationsContract)
  notificationsRouter() {
    return {
      list: implement(notificationsContract.list).handler(({ context }) => {
        const req = (context as { request: Request }).request;
        const userId = req.headers['x-user-id'] as string;
        return this.notifications.listForUser(userId).then((items) =>
          items.map((n) => ({
            ...n,
            readAt: n.readAt ? n.readAt.toISOString() : null,
            createdAt: n.createdAt.toISOString(),
          })),
        );
      }),

      markRead: implement(notificationsContract.markRead).handler(async ({ input, context }) => {
        const req = (context as { request: Request }).request;
        const userId = req.headers['x-user-id'] as string;
        try {
          await this.notifications.markRead(input.id, userId);
          return { success: true as const };
        } catch (err) {
          if (err instanceof NotificationNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          if (err instanceof NotificationOwnershipError) {
            throw new ORPCError('FORBIDDEN', { message: err.message });
          }
          throw err;
        }
      }),

      markAllRead: implement(notificationsContract.markAllRead).handler(({ context }) => {
        const req = (context as { request: Request }).request;
        const userId = req.headers['x-user-id'] as string;
        return this.notifications.markAllRead(userId);
      }),
    };
  }
}

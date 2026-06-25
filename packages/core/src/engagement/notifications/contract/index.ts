import { oc } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema, UuidSchema } from '@blurifycom/core/contracts';

export const NotificationSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: z.string(),
  title: z.string(),
  body: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const notificationsContract = {
  list: oc.route({ method: 'GET', path: '/notifications' }).output(z.array(NotificationSchema)),

  markRead: oc
    .route({ method: 'POST', path: '/notifications/{id}/read' })
    .input(IdInputSchema)
    .output(z.object({ success: z.literal(true) })),

  markAllRead: oc
    .route({ method: 'POST', path: '/notifications/read-all' })
    .output(z.object({ count: z.number() })),
};

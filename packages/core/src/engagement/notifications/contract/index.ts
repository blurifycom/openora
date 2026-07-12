import { oc } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema, TimestampSchema, UuidSchema } from '@openora/core/contracts';

export const NOTIFICATION_TYPES = ['withdrawal.approved', 'withdrawal.rejected'] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

export const NotificationSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: NotificationTypeSchema,
  title: z.string(),
  body: z.string(),
  readAt: z.string().nullable(),
  createdAt: TimestampSchema,
});

// Internal-only - fed by domain-event handlers in plugin.ts, not a wire route.
export const CreateNotificationInputSchema = z.object({
  userId: UuidSchema,
  type: NotificationTypeSchema,
  title: z.string(),
  body: z.string(),
});
export type CreateNotificationInput = z.infer<typeof CreateNotificationInputSchema>;

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

import { eventIterator, oc } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema, TimestampSchema, UuidSchema } from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';

export const NOTIFICATION_TYPES = [
  'withdrawal.approved',
  'withdrawal.rejected',
  'kyc.resubmission_requested',
  'social.friend_request.received',
  'social.friend_request.accepted',
  'wallet.bonus_rollover.completed',
  'deposit.completed',
  'balance.adjusted',
  'withdrawal.requested',
  'withdrawal.completed',
  'withdrawal.failed',
  'tip.received',
  'chat.mention',
] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

// Bare entity-reference IDs mirrored from the source domain event's own payload (eg
// `{ roomId, messageId }`) - never a path, URL, or asset reference. Lets a consumer
// build its own banner/CTA mapping keyed off `type` without openora knowing routes.
export const NotificationDataSchema = z.record(z.string(), z.string());
export type NotificationData = z.infer<typeof NotificationDataSchema>;

export const NotificationSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: NotificationTypeSchema,
  title: z.string(),
  body: z.string(),
  data: NotificationDataSchema.nullable(),
  readAt: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

// Internal-only - fed by domain-event handlers in plugin.ts, not a wire route.
export const CreateNotificationInputSchema = z.object({
  userId: UuidSchema,
  type: NotificationTypeSchema,
  title: z.string(),
  body: z.string(),
  data: NotificationDataSchema.nullable().optional(),
  eventId: UuidSchema.nullable().optional(),
});
export type CreateNotificationInput = z.infer<typeof CreateNotificationInputSchema>;

export const NOTIFICATION_SORT_BY_VALUES = ['createdAt'] as const;
export const NotificationSortBySchema = z.enum(NOTIFICATION_SORT_BY_VALUES).default('createdAt');
export type NotificationSortBy = z.infer<typeof NotificationSortBySchema>;

export const NotificationCountSchema = z.object({ count: z.number() });
export type NotificationCount = z.infer<typeof NotificationCountSchema>;

export const MarkNotificationReadOutputSchema = z.object({ success: z.literal(true) });
export type MarkNotificationReadOutput = z.infer<typeof MarkNotificationReadOutputSchema>;

export const notificationsContract = {
  list: oc
    .route({ method: 'GET', path: '/notifications' })
    .input(
      PageQuerySchema.extend({
        sortBy: NotificationSortBySchema.optional(),
        sortOrder: SortOrderSchema.default('desc').optional(),
      }),
    )
    .output(paginated(NotificationSchema)),

  unreadCount: oc
    .route({ method: 'GET', path: '/notifications/unread-count' })
    .output(NotificationCountSchema),

  stream: oc
    .route({ method: 'GET', path: '/notifications/stream' })
    .output(eventIterator(NotificationSchema)),

  markRead: oc
    .route({ method: 'POST', path: '/notifications/{id}/read' })
    .input(IdInputSchema)
    .output(MarkNotificationReadOutputSchema),

  markAllRead: oc
    .route({ method: 'POST', path: '/notifications/read-all' })
    .output(NotificationCountSchema),
};

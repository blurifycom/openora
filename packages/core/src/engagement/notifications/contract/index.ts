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
  'promo.bonus.granted',
  'promo.bonus.completed',
  'promo.bonus.forfeited',
  'promo.bonus.expired',
  'promo.race.won',
  'promo.rank-challenge.won',
  'promo.rank.changed',
  'chat.rain.received',
  'chat.tip.received',
  'chat.gift.claimed',
  'chat.gift.expired',
  'rg.limit.admin_updated',
  'deposit.completed',
  'deposit.held',
  'balance.adjusted',
  'withdrawal.requested',
  'withdrawal.completed',
  'withdrawal.failed',
  'chat.mention',
  'chat.room.ownership_transferred',
  'chat.room.scheduled_for_deletion',
  'chat.room_invite.received',
  // Core never emits this one: it is the seam for an operator-run VIP programme, whose overlay
  // tells the player through its own NotificationsService when it admits them.
  'vip.assigned',
] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

// Bare entity-reference IDs mirrored from the source domain event's own payload (eg
// `{ roomId, messageId }`) - never a path, URL, or asset reference. Lets a consumer
// build its own banner/CTA mapping keyed off `type` without openora knowing routes.
export const NotificationDataSchema = z.record(z.string(), z.string());
export type NotificationData = z.infer<typeof NotificationDataSchema>;

// The values a notification's sentence needs; the client renders `type` as an i18n key with these.
export const NotificationParamsSchema = z.record(z.string(), z.string());
export type NotificationParams = z.infer<typeof NotificationParamsSchema>;

/**
 * The `params` keys each notification type carries. Values are raw: amounts are unformatted
 * decimal strings and codes (a forfeit reason, a limit period or type, an adjustment direction)
 * are untranslated - the client formats and translates them for the player's locale.
 */
export const NOTIFICATION_PARAM_KEYS = {
  'withdrawal.approved': { required: ['amount', 'currency'], optional: [] },
  'withdrawal.rejected': { required: ['amount', 'currency'], optional: ['reason'] },
  'withdrawal.requested': { required: ['amount', 'currency'], optional: [] },
  'withdrawal.completed': { required: ['amount', 'currency'], optional: [] },
  'withdrawal.failed': { required: ['amount', 'currency'], optional: [] },
  'deposit.completed': { required: ['amount', 'currency'], optional: [] },
  'deposit.held': { required: ['amount', 'currency'], optional: [] },
  'balance.adjusted': { required: ['direction', 'amount', 'currency'], optional: [] },
  'promo.bonus.granted': {
    required: ['grantedAmount', 'wageringRequired', 'currency', 'source'],
    optional: ['rankBonusKind'],
  },
  'promo.bonus.completed': { required: ['amount', 'currency'], optional: [] },
  'promo.bonus.forfeited': { required: ['amount', 'currency', 'reason'], optional: [] },
  'promo.bonus.expired': { required: ['amount', 'currency'], optional: [] },
  'promo.race.won': { required: ['position', 'raceName', 'amount', 'currency'], optional: [] },
  'promo.rank-challenge.won': {
    required: ['tierName', 'currency'],
    optional: ['cashAmount', 'physicalItem'],
  },
  'promo.rank.changed': {
    required: [],
    optional: [
      'tierName',
      'currency',
      'rakebackPercent',
      'levelUpBonus',
      'dailyBonus',
      'weeklyBonus',
      'monthlyBonus',
    ],
  },
  'chat.mention': { required: [], optional: [] },
  'chat.room_invite.received': { required: ['inviterUsername', 'roomName'], optional: [] },
  'social.friend_request.received': { required: ['requesterUsername'], optional: [] },
  'social.friend_request.accepted': { required: ['accepterUsername'], optional: [] },
  'chat.room.ownership_transferred': { required: ['roomName'], optional: [] },
  'chat.room.scheduled_for_deletion': { required: ['roomName'], optional: [] },
  'kyc.resubmission_requested': { required: [], optional: ['reason'] },
  'rg.limit.admin_updated': {
    required: ['period', 'limitType'],
    optional: ['previousAmount', 'previousMinutes', 'amount', 'minutes'],
  },
  'chat.rain.received': { required: ['amount', 'currency'], optional: [] },
  'chat.gift.expired': { required: ['amount', 'currency'], optional: [] },
  'chat.tip.received': { required: ['senderUsername', 'amount', 'currency'], optional: [] },
  'chat.gift.claimed': { required: ['claimerUsername', 'amount', 'currency'], optional: [] },
  'vip.assigned': { required: [], optional: [] },
} as const satisfies Record<
  NotificationType,
  { required: readonly string[]; optional: readonly string[] }
>;

export const NotificationSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: NotificationTypeSchema,
  params: NotificationParamsSchema.nullable(),
  data: NotificationDataSchema.nullable(),
  readAt: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

// Internal-only - fed by domain-event handlers in plugin.ts and by overlays, not a wire route.
// `params` present must match its type's NOTIFICATION_PARAM_KEYS; absent stays valid, since a
// dispatch job queued before params existed carries none.
export const CreateNotificationInputSchema = z
  .object({
    userId: UuidSchema,
    type: NotificationTypeSchema,
    params: NotificationParamsSchema.nullable().optional(),
    data: NotificationDataSchema.nullable().optional(),
    eventId: UuidSchema.nullable().optional(),
  })
  .superRefine(({ type, params }, ctx) => {
    if (!params) {
      return;
    }
    const { required, optional } = NOTIFICATION_PARAM_KEYS[type];
    const allowed: readonly string[] = [...required, ...optional];
    for (const key of required.filter((k) => params[k] === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['params', key], message: `required for ${type}` });
    }
    for (const key of Object.keys(params).filter((k) => !allowed.includes(k))) {
      ctx.addIssue({ code: 'custom', path: ['params', key], message: `not declared for ${type}` });
    }
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

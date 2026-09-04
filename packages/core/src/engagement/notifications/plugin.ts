import * as z from 'zod';
import {
  ADMIN_USER_DIRECTORY,
  IDENTITY_READER,
  JOB_QUEUE,
  NOTIFICATION_DELIVERY_ADAPTER,
  PLATFORM_CONFIG,
  REALTIME_TRANSPORT,
  UuidSchema,
  domainEventSchemas,
  queue,
  type AdminUserDirectory,
  type DomainEventName,
  type DomainEventPayload,
  type IdentityReader,
  type JobQueueAdapter,
  type NotificationDeliveryAdapter,
  type RealtimeTransport,
} from '@openora/core/contracts';
import { createLogger, EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { MockNotificationDeliveryAdapter } from './adapters/mock/mock-notification-adapter.js';
import {
  createNotificationsRouter,
  notificationsChannel,
  toNotificationDto,
} from './router/index.js';
import { NotificationsService } from './service/notifications.service.js';
import { CreateNotificationInputSchema, type CreateNotificationInput } from './contract/index.js';

const describeLimitValue = (amount: string | null, minutes: number | null): string =>
  amount !== null ? amount : `${minutes} minutes`;

const KYC_RESUBMISSION_NOTIFY_QUEUE = queue('kyc-resubmission-notify');
const NOTIFICATIONS_RETENTION_PURGE_QUEUE = queue('notifications-retention-purge');
const NOTIFICATIONS_DISPATCH_QUEUE = queue('notifications-dispatch');
const SECURITY_ALERT_DISPATCH_QUEUE = queue('security-alert-dispatch');

const DEFAULT_NOTIFICATIONS_RETENTION_DAYS = 30;
const DEFAULT_NOTIFICATIONS_RETENTION_CRON = '0 3 * * *';

const KycResubmissionNotifyJobSchema = z.object({
  userId: UuidSchema,
  reason: z.string().nullable(),
});

const NotificationDispatchJobSchema = z.object({
  event: z.string(),
  input: CreateNotificationInputSchema,
  sendEmail: z.boolean(),
  // Backlog jobs produced before security alerts existed omit this field.
  sendSecurityAlertEmail: z.boolean().default(false),
});

const SecurityAlertDispatchJobSchema = z.object({
  userId: UuidSchema,
  eventId: UuidSchema,
});

function formatMoneyAmount(amount: string): string {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) {
    return amount;
  }
  const [, sign, integerPart, fractionPart] = match;
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimmedFraction = fractionPart ? fractionPart.replace(/0+$/, '') : '';
  const magnitude = trimmedFraction ? `${groupedInteger}.${trimmedFraction}` : groupedInteger;
  return sign ? `${sign}${magnitude}` : magnitude;
}

type NotificationMapEntry = {
  event: DomainEventName;
  sendEmail: boolean;
  handle: (payload: unknown) => CreateNotificationInput | null;
};

// Drops null/undefined entity refs (eg a nullable roomId) so `data` only ever carries
// fields the source event actually had a value for; an all-null payload becomes `null`.
function compactData(
  fields: Record<string, string | null | undefined>,
): Record<string, string> | null {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

// A plain array literal would widen every entry's `event` to DomainEventName and lose the
// payload type tied to it; this generic keeps K bound per entry so buildNotification stays
// checked against that one event's actual payload shape.
function mapEvent<K extends DomainEventName>(
  event: K,
  buildNotification: (payload: DomainEventPayload<K>) => CreateNotificationInput,
  options: { sendEmail: boolean },
): NotificationMapEntry {
  return {
    event,
    sendEmail: options.sendEmail,
    handle: (payload) => {
      const parsed = domainEventSchemas[event].safeParse(payload);
      if (!parsed.success) {
        return null;
      }
      // Library boundary: TS cannot narrow a domainEventSchemas lookup keyed by this
      // function's own generic K to that one event's payload type; the pairing holds
      // by domainEventSchemas' own definition (DomainEventPayload<K> is inferred from it).
      return buildNotification(parsed.data as DomainEventPayload<K>);
    },
  };
}

export const notificationEventMap: NotificationMapEntry[] = [
  mapEvent(
    'wallet.withdrawal.approved',
    (p) => ({
      userId: p.userId,
      type: 'withdrawal.approved',
      title: 'Withdrawal approved',
      body: `Your withdrawal of ${formatMoneyAmount(p.amount)} ${p.currency} has been approved and is being processed.`,
      data: { transactionId: p.transactionId },
    }),
    { sendEmail: true },
  ),

  mapEvent(
    'wallet.withdrawal.rejected',
    (p) => ({
      userId: p.userId,
      type: 'withdrawal.rejected',
      title: 'Withdrawal rejected',
      body: `Your withdrawal of ${formatMoneyAmount(p.amount)} ${p.currency} was rejected and the funds were returned to your balance.${p.reason ? ` Reason: ${p.reason}.` : ''}`,
      data: { transactionId: p.transactionId },
    }),
    { sendEmail: true },
  ),

  mapEvent(
    'wallet.withdrawal.requested',
    (p) => ({
      userId: p.userId,
      type: 'withdrawal.requested',
      title: 'Withdrawal requested',
      body: `Your withdrawal request of ${formatMoneyAmount(p.amount)} ${p.currency} has been received and is pending review.`,
      data: { transactionId: p.transactionId },
    }),
    { sendEmail: false },
  ),

  mapEvent(
    'wallet.withdrawal.completed',
    (p) => ({
      userId: p.userId,
      type: 'withdrawal.completed',
      title: 'Withdrawal completed',
      body: `Your withdrawal of ${formatMoneyAmount(p.amount)} ${p.currency} has been completed.`,
      data: { transactionId: p.transactionId },
    }),
    { sendEmail: false },
  ),

  mapEvent(
    'wallet.withdrawal.failed',
    (p) => ({
      userId: p.userId,
      type: 'withdrawal.failed',
      title: 'Withdrawal failed',
      body: `Your withdrawal of ${formatMoneyAmount(p.amount)} ${p.currency} failed and the funds were returned to your balance.`,
      data: { transactionId: p.transactionId },
    }),
    { sendEmail: false },
  ),

  mapEvent(
    'wallet.deposit.completed',
    (p) => ({
      userId: p.userId,
      type: 'deposit.completed',
      title: 'Deposit completed',
      body: `Your deposit of ${formatMoneyAmount(p.amount)} ${p.currency} has been completed.`,
      data: { transactionId: p.transactionId },
    }),
    { sendEmail: false },
  ),

  mapEvent(
    'wallet.manual_adjustment.created',
    (p) => ({
      userId: p.userId,
      type: 'balance.adjusted',
      title: 'Balance adjusted',
      body: `Your balance was ${p.direction === 'credit' ? 'credited' : 'debited'} ${formatMoneyAmount(p.amount)} ${p.currency}. Reason: ${p.reason}.`,
      data: { transactionId: p.transactionId },
    }),
    { sendEmail: false },
  ),

  mapEvent(
    'wallet.bonus_rollover.completed',
    (p) => ({
      userId: p.userId,
      type: 'wallet.bonus_rollover.completed',
      title: 'Bonus unlocked',
      body: `Your ${formatMoneyAmount(p.creditedAmount)} ${p.currency} bonus credit has cleared its rollover requirement and is now fully withdrawable.`,
      data: null,
    }),
    { sendEmail: false },
  ),

  mapEvent(
    'chat.user.mentioned',
    (p) => ({
      userId: p.mentionedUserId,
      type: 'chat.mention',
      title: 'You were mentioned',
      body: 'You were mentioned in a chat message.',
      data: compactData({ roomId: p.roomId, messageId: p.messageId }),
    }),
    { sendEmail: false },
  ),

  // Pre-existing types: in-app only, unchanged from before the declarative-map refactor.
  mapEvent(
    'social.friend_request.sent',
    (p) => ({
      userId: p.addresseeId,
      type: 'social.friend_request.received',
      title: 'New friend request',
      body: `${p.requesterUsername} sent you a friend request.`,
      data: { requesterId: p.requesterId },
    }),
    { sendEmail: false },
  ),

  mapEvent(
    'social.friend_request.accepted',
    (p) => ({
      userId: p.requesterId,
      type: 'social.friend_request.accepted',
      title: 'Friend request accepted',
      body: `${p.accepterUsername} accepted your friend request.`,
      // accepterId, not requesterId: the recipient of THIS notification is the
      // requester, so the linkable "other party" is whoever just accepted.
      data: { accepterId: p.accepterId },
    }),
    { sendEmail: false },
  ),

  mapEvent(
    'chat.room.ownership.transferred',
    (p) => ({
      userId: p.newOwnerId,
      type: 'chat.room.ownership_transferred',
      title: 'You are now the owner of a chat room',
      body: `The owner of "${p.roomName}" had their account removed, so ownership of the room has passed to you.`,
      data: { roomId: p.roomId },
    }),
    { sendEmail: false },
  ),
];

export function buildKycResubmissionNotification(payload: {
  userId: string;
  reason: string | null;
}): CreateNotificationInput {
  return {
    userId: payload.userId,
    type: 'kyc.resubmission_requested',
    title: 'Document resubmission required',
    body: `An admin has requested you resubmit your verification documents.${payload.reason ? ` Reason: ${payload.reason}.` : ''}`,
    data: null,
  };
}

export function buildChatRoomScheduledForDeletionNotification(payload: {
  userId: string;
  roomId: string;
  roomName: string;
}): CreateNotificationInput {
  return {
    userId: payload.userId,
    type: 'chat.room.scheduled_for_deletion',
    title: 'Chat room closing',
    body: `The owner of "${payload.roomName}" had their account removed and no moderator could take the room over. It will be permanently deleted in 30 days.`,
    data: { roomId: payload.roomId },
  };
}

export default {
  id: 'notifications',
  // ADMIN_USER_DIRECTORY (owned by identity) resolves the player's email for the
  // delivery emails; pin load order so a split still finds the port. See ADR-0017.
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => new MockNotificationDeliveryAdapter());

    const logger = createLogger('notifications');

    // Subscriptions are wired before router factories run (boot order), so these refs are
    // null at registration but set from the router factory before any real event arrives.
    let svcRef: NotificationsService | null = null;
    let deliveryRef: NotificationDeliveryAdapter | null = null;
    let directoryRef: AdminUserDirectory | null = null;
    let identityReaderRef: IdentityReader | null = null;
    let jobQueueRef: JobQueueAdapter | null = null;
    let realtimeRef: RealtimeTransport | null = null;
    let retentionDaysRef = DEFAULT_NOTIFICATIONS_RETENTION_DAYS;

    // Best-effort email alongside the in-app notification; a missing user or delivery
    // failure is logged, never thrown - the in-app notification already landed.
    const sendEmail = (userId: string, title: string, body: string) => {
      if (!deliveryRef || !directoryRef) {
        return;
      }
      const delivery = deliveryRef;
      directoryRef
        .get(userId)
        .then((user) => {
          if (!user?.email) {
            logger.warn({ userId }, 'notification email skipped: no email for user');
            return;
          }
          return delivery.sendEmail(user.email, title, body);
        })
        .catch((err) => logger.error({ err }, 'notification email delivery failed'));
    };

    // Security alerts are explicitly opt-in and require a currently verified email.
    // Unlike the ordinary notification email helper above, delivery errors are surfaced to the
    // queue worker so they use its retry/dead-letter policy.
    const sendSecurityAlertEmail = async (userId: string, title: string, body: string) => {
      if (!deliveryRef || !directoryRef || !identityReaderRef) {
        return;
      }
      if (!(await identityReaderRef.canReceiveLoginWithdrawalAlerts?.(userId))) {
        return;
      }
      const recipient = await directoryRef.get(userId);
      if (!recipient?.email) {
        logger.warn({ userId }, 'security alert email skipped: no email for user');
        return;
      }
      await deliveryRef.sendEmail(recipient.email, title, body);
    };

    const publishNotification = (
      record: NonNullable<Awaited<ReturnType<NotificationsService['create']>>>,
    ) => {
      if (!realtimeRef) {
        return;
      }
      const dto = toNotificationDto(record);
      if (dto) {
        void Promise.resolve(realtimeRef.publish(notificationsChannel(record.userId), dto)).catch(
          (err: unknown) => logger.error({ err }, 'notification realtime publish failed'),
        );
      }
    };

    for (const entry of notificationEventMap) {
      ctx.events.on(entry.event, (payload, envelope) => {
        const input = entry.handle(payload);
        if (!input || !jobQueueRef || !envelope) {
          return;
        }
        jobQueueRef
          .enqueue(
            NOTIFICATIONS_DISPATCH_QUEUE,
            {
              event: entry.event,
              input: { ...input, eventId: envelope.eventId },
              sendEmail: entry.sendEmail,
              // `wallet.withdrawal.requested` already creates an in-app notification. Its
              // existing dispatch is enriched with a preference-gated email rather than adding
              // a second record or a second subscription.
              sendSecurityAlertEmail: entry.event === 'wallet.withdrawal.requested',
            },
            {
              idempotencyKey: `notifications-dispatch:${envelope.eventId}`,
              attempts: 5,
              backoff: { type: 'exponential', delayMs: 1000 },
            },
          )
          .catch((err) =>
            logger.error({ err, event: entry.event }, 'notification dispatch enqueue failed'),
          );
      });
    }

    ctx.events.on('identity.authentication.succeeded', async (payload, envelope) => {
      const parsed = domainEventSchemas['identity.authentication.succeeded'].safeParse(payload);
      if (!parsed.success || !jobQueueRef || !identityReaderRef) {
        return;
      }
      if (!envelope?.eventId) {
        logger.warn(
          { userId: parsed.data.userId },
          'security login alert enqueue skipped: missing event id',
        );
        return;
      }
      // Skip the job entirely for the normal opt-out case. Delivery checks the same
      // current state again, so a preference or email change between here and the
      // worker cannot result in a stale-address email.
      if (!(await identityReaderRef.canReceiveLoginWithdrawalAlerts?.(parsed.data.userId))) {
        return;
      }
      await jobQueueRef.enqueue(
        SECURITY_ALERT_DISPATCH_QUEUE,
        { userId: parsed.data.userId, eventId: envelope.eventId },
        {
          idempotencyKey: `security-login-alert:${envelope.eventId}`,
          attempts: 5,
          backoff: { type: 'exponential', delayMs: 1000 },
        },
      );
    });

    // Non-null `reason` marks an admin override (ADR-0037); player-initiated
    // limit changes always emit `reason: null`.
    ctx.events.on('rg.limit.set', (payload) => {
      const parsed = domainEventSchemas['rg.limit.set'].safeParse(payload);
      if (!parsed.success || !svcRef || parsed.data.reason === null) {
        return;
      }
      const p = parsed.data;
      const title = 'Your responsible gambling limit was changed';
      const previous =
        p.previousAmount !== null || p.previousMinutes !== null
          ? describeLimitValue(p.previousAmount, p.previousMinutes)
          : 'no prior limit';
      const next = describeLimitValue(p.amount, p.minutes);
      const body = `An administrator changed your ${p.period} ${p.type} limit from ${previous} to ${next}.`;
      // In-app only: `RgService.setPlayerLimit` already sends the `rgLimitUpdated` mail on this write.
      svcRef
        .create({ userId: p.userId, type: 'rg.limit.admin_updated', title, body })
        .catch((err) => logger.error({ err }, 'rg.limit.set admin-override notification failed'));
    });

    ctx.events.on('chat.room.scheduled_for_deletion', (payload, envelope) => {
      const parsed = domainEventSchemas['chat.room.scheduled_for_deletion'].safeParse(payload);
      if (!parsed.success || !jobQueueRef) {
        return;
      }
      const p = parsed.data;
      if (!envelope?.eventId) {
        logger.warn({ roomId: p.roomId }, 'chat-room-deletion notify skipped: missing eventId');
        return;
      }
      const eventId = envelope.eventId;
      const jobQueue = jobQueueRef;
      for (const userId of p.memberIds.filter((id) => id !== p.previousOwnerId)) {
        jobQueue
          .enqueue(
            NOTIFICATIONS_DISPATCH_QUEUE,
            {
              event: 'chat.room.scheduled_for_deletion',
              input: buildChatRoomScheduledForDeletionNotification({
                userId,
                roomId: p.roomId,
                roomName: p.roomName,
              }),
              sendEmail: false,
            },
            {
              idempotencyKey: `notifications-dispatch:${eventId}:${userId}`,
              attempts: 5,
              backoff: { type: 'exponential', delayMs: 1000 },
            },
          )
          .catch((err) =>
            logger.error({ err }, 'chat.room.scheduled_for_deletion dispatch enqueue failed'),
          );
      }
    });

    ctx.events.on('compliance.kyc.updated', (payload, envelope) => {
      const parsed = domainEventSchemas['compliance.kyc.updated'].safeParse(payload);
      if (!parsed.success || !jobQueueRef) {
        return;
      }
      const p = parsed.data;
      // Generic copy below assumes basic-tier document requirements; advanced-tier
      // resubmission has no tier-specific copy yet (see tag-evaluation.service.ts's
      // same guard).
      if (p.status !== 'resubmission_requested' || p.source !== 'manual' || p.tier !== 'basic') {
        return;
      }
      if (!envelope?.eventId) {
        logger.warn(
          { userId: p.userId },
          'kyc-resubmission-notify enqueue skipped: missing eventId',
        );
        return;
      }
      jobQueueRef
        .enqueue(
          KYC_RESUBMISSION_NOTIFY_QUEUE,
          { userId: p.userId, reason: p.reason },
          { idempotencyKey: `kyc-resubmission-notify:${envelope.eventId}` },
        )
        .catch((err) => logger.error({ err }, 'kyc-resubmission-notify enqueue failed'));
    });

    ctx.jobs.worker({
      queue: KYC_RESUBMISSION_NOTIFY_QUEUE,
      schema: KycResubmissionNotifyJobSchema,
      handler: async ({ payload }) => {
        if (!svcRef) {
          return;
        }
        const input = buildKycResubmissionNotification(payload);
        const record = await svcRef.create(input);
        if (!record) {
          return;
        }
        publishNotification(record);
        sendEmail(input.userId, input.title, input.body);
      },
    });

    ctx.jobs.worker({
      queue: NOTIFICATIONS_DISPATCH_QUEUE,
      schema: NotificationDispatchJobSchema,
      handler: async ({ payload }) => {
        if (!svcRef) {
          return;
        }
        const record = await svcRef.create(payload.input);
        if (!record) {
          // A prior attempt may have already persisted the in-app notification. Continue so a
          // retried security email can still be delivered through this job's retry policy.
          if (payload.sendSecurityAlertEmail) {
            await sendSecurityAlertEmail(
              payload.input.userId,
              payload.input.title,
              payload.input.body,
            );
          }
          return;
        }
        publishNotification(record);
        if (payload.sendEmail) {
          sendEmail(payload.input.userId, payload.input.title, payload.input.body);
        }
        if (payload.sendSecurityAlertEmail) {
          await sendSecurityAlertEmail(
            payload.input.userId,
            payload.input.title,
            payload.input.body,
          );
        }
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error(
          { err: error, event: jobCtx.payload.event, jobId: jobCtx.id },
          'notification dispatch exhausted retries',
        );
      },
    });

    ctx.jobs.worker({
      queue: SECURITY_ALERT_DISPATCH_QUEUE,
      schema: SecurityAlertDispatchJobSchema,
      handler: async ({ payload }) => {
        await sendSecurityAlertEmail(
          payload.userId,
          'New sign-in to your account',
          'A new sign-in to your account was detected. If this was not you, secure your account immediately.',
        );
      },
      onDeadLetter: (jobCtx, error) => {
        logger.error(
          { err: error, userId: jobCtx.payload.userId, jobId: jobCtx.id },
          'security login alert delivery exhausted retries',
        );
      },
    });

    ctx.jobs.worker({
      queue: NOTIFICATIONS_RETENTION_PURGE_QUEUE,
      schema: z.object({}),
      handler: async () => {
        if (!svcRef) {
          return;
        }
        const { count } = await svcRef.purgeExpired(retentionDaysRef);
        logger.info({ count }, 'notification retention purge complete');
      },
    });

    ctx.routers.add('notifications', (c) => {
      const svc = new NotificationsService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      deliveryRef = c.get(NOTIFICATION_DELIVERY_ADAPTER);
      directoryRef = c.get(ADMIN_USER_DIRECTORY);
      identityReaderRef = c.get(IDENTITY_READER);
      jobQueueRef = c.get(JOB_QUEUE);
      realtimeRef = c.get(REALTIME_TRANSPORT);
      const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      retentionDaysRef =
        platformConfig?.notifications?.retention?.days ?? DEFAULT_NOTIFICATIONS_RETENTION_DAYS;
      const purgeCron =
        platformConfig?.notifications?.retention?.cron ?? DEFAULT_NOTIFICATIONS_RETENTION_CRON;
      // Off-peak, one hour after tag's daily-evaluation (0 2 * * *), so the in-process
      // driver doesn't run both sweeps at once in dev/test.
      void jobQueueRef.schedule(
        NOTIFICATIONS_RETENTION_PURGE_QUEUE,
        'notifications.retention-purge.daily',
        {},
        { cron: purgeCron },
      );
      return createNotificationsRouter({ notifications: svc, realtime: realtimeRef });
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

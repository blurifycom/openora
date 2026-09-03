import * as z from 'zod';
import {
  JOB_QUEUE,
  MAIL_DISPATCH,
  MailTemplateSchema,
  PLATFORM_CONFIG,
  REALTIME_TRANSPORT,
  UuidSchema,
  domainEventSchemas,
  formatMoneyAmount,
  queue,
  type DomainEventName,
  type DomainEventPayload,
  type JobQueueAdapter,
  type MailDispatchPort,
  type MailTemplate,
  type RealtimeTransport,
} from '@openora/core/contracts';
import { createLogger, EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
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

const DEFAULT_NOTIFICATIONS_RETENTION_DAYS = 30;
const DEFAULT_NOTIFICATIONS_RETENTION_CRON = '0 3 * * *';

const KycResubmissionNotifyJobSchema = z.object({
  userId: UuidSchema,
  reason: z.string().nullable(),
  eventId: UuidSchema,
});

const NotificationDispatchJobSchema = z.object({
  event: z.string(),
  input: CreateNotificationInputSchema,
  // The `{ key, data }` mail template to enqueue alongside the in-app notification,
  // or null for an in-app-only event. Replaces the old `sendEmail: boolean` - a flag
  // can't carry the template key or its data (that's why four mails used to go out as
  // the notification's English body). See ADR-0036.
  email: MailTemplateSchema.nullable(),
});

type NotificationMapEntry = {
  event: DomainEventName;
  handle: (payload: unknown) => CreateNotificationInput | null;
  // Builds the mail template for this event, or null when the event is in-app only.
  // `occurredAt` is the envelope timestamp - the mail must date from when the event
  // happened, never from when the (possibly retried) worker ran.
  buildEmail: (payload: unknown, occurredAt: string) => MailTemplate | null;
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
  options?: { email: (payload: DomainEventPayload<K>, occurredAt: string) => MailTemplate },
): NotificationMapEntry {
  // Library boundary: TS cannot narrow a domainEventSchemas lookup keyed by this
  // function's own generic K to that one event's payload type; the pairing holds
  // by domainEventSchemas' own definition (DomainEventPayload<K> is inferred from it).
  const parse = (payload: unknown): DomainEventPayload<K> | null => {
    const parsed = domainEventSchemas[event].safeParse(payload);
    return parsed.success ? (parsed.data as DomainEventPayload<K>) : null;
  };
  return {
    event,
    handle: (payload) => {
      const data = parse(payload);
      return data ? buildNotification(data) : null;
    },
    buildEmail: (payload, occurredAt) => {
      if (!options?.email) {
        return null;
      }
      const data = parse(payload);
      return data ? options.email(data, occurredAt) : null;
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
    {
      email: (p, occurredAt) => ({
        key: 'withdrawalApproved',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
        },
      }),
    },
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
    {
      email: (p, occurredAt) => ({
        key: 'withdrawalRejected',
        data: {
          amount: p.amount,
          currency: p.currency,
          transactionId: p.transactionId,
          occurredAt,
          reason: p.reason,
        },
      }),
    },
  ),

  mapEvent('wallet.withdrawal.requested', (p) => ({
    userId: p.userId,
    type: 'withdrawal.requested',
    title: 'Withdrawal requested',
    body: `Your withdrawal request of ${formatMoneyAmount(p.amount)} ${p.currency} has been received and is pending review.`,
    data: { transactionId: p.transactionId },
  })),

  mapEvent('wallet.withdrawal.completed', (p) => ({
    userId: p.userId,
    type: 'withdrawal.completed',
    title: 'Withdrawal completed',
    body: `Your withdrawal of ${formatMoneyAmount(p.amount)} ${p.currency} has been completed.`,
    data: { transactionId: p.transactionId },
  })),

  mapEvent('wallet.withdrawal.failed', (p) => ({
    userId: p.userId,
    type: 'withdrawal.failed',
    title: 'Withdrawal failed',
    body: `Your withdrawal of ${formatMoneyAmount(p.amount)} ${p.currency} failed and the funds were returned to your balance.`,
    data: { transactionId: p.transactionId },
  })),

  mapEvent('wallet.deposit.completed', (p) => ({
    userId: p.userId,
    type: 'deposit.completed',
    title: 'Deposit completed',
    body: `Your deposit of ${formatMoneyAmount(p.amount)} ${p.currency} has been completed.`,
    data: { transactionId: p.transactionId },
  })),

  mapEvent('wallet.manual_adjustment.created', (p) => ({
    userId: p.userId,
    type: 'balance.adjusted',
    title: 'Balance adjusted',
    body: `Your balance was ${p.direction === 'credit' ? 'credited' : 'debited'} ${formatMoneyAmount(p.amount)} ${p.currency}. Reason: ${p.reason}.`,
    data: { transactionId: p.transactionId },
  })),

  mapEvent('wallet.bonus_rollover.completed', (p) => ({
    userId: p.userId,
    type: 'wallet.bonus_rollover.completed',
    title: 'Bonus unlocked',
    body: `Your ${formatMoneyAmount(p.creditedAmount)} ${p.currency} bonus credit has cleared its rollover requirement and is now fully withdrawable.`,
    data: null,
  })),

  mapEvent('chat.user.mentioned', (p) => ({
    userId: p.mentionedUserId,
    type: 'chat.mention',
    title: 'You were mentioned',
    body: 'You were mentioned in a chat message.',
    data: compactData({ roomId: p.roomId, messageId: p.messageId }),
  })),

  // Pre-existing types: in-app only, unchanged from before the declarative-map refactor.
  mapEvent('social.friend_request.sent', (p) => ({
    userId: p.addresseeId,
    type: 'social.friend_request.received',
    title: 'New friend request',
    body: `${p.requesterUsername} sent you a friend request.`,
    data: { requesterId: p.requesterId },
  })),

  mapEvent('social.friend_request.accepted', (p) => ({
    userId: p.requesterId,
    type: 'social.friend_request.accepted',
    title: 'Friend request accepted',
    body: `${p.accepterUsername} accepted your friend request.`,
    // accepterId, not requesterId: the recipient of THIS notification is the
    // requester, so the linkable "other party" is whoever just accepted.
    data: { accepterId: p.accepterId },
  })),
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

export default {
  id: 'notifications',
  register(ctx) {
    const logger = createLogger('notifications');

    // Subscriptions are wired before router factories run (boot order), so these refs are
    // null at registration but set from the router factory before any real event arrives.
    let svcRef: NotificationsService | null = null;
    // Resolved lazily (router factory) so notifications does not depend on the mail
    // plugin's load order. The mail module OWNS address + locale resolution and the
    // send path - this module only names the template. See ADR-0036.
    let mailDispatchRef: MailDispatchPort | null = null;
    let jobQueueRef: JobQueueAdapter | null = null;
    let realtimeRef: RealtimeTransport | null = null;
    let retentionDaysRef = DEFAULT_NOTIFICATIONS_RETENTION_DAYS;

    // Hands a template to the mail module keyed by the source event, so a redelivered
    // event never doubles the mail. Never throws into the caller - the in-app
    // notification has already landed; the enqueue is retried inside the mail module.
    const dispatchMail = async (
      userId: string,
      template: MailTemplate,
      eventId: string,
    ): Promise<void> => {
      if (!mailDispatchRef) {
        return;
      }
      try {
        await mailDispatchRef.toUser({
          userId,
          template,
          idempotencyKey: `notifications-mail:${eventId}`,
        });
      } catch (err) {
        logger.error({ err, key: template.key }, 'notification mail enqueue failed');
      }
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
              email: entry.buildEmail(payload, envelope.occurredAt),
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
          { userId: p.userId, reason: p.reason, eventId: envelope.eventId },
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
        await dispatchMail(
          payload.userId,
          { key: 'kycResubmissionRequested', data: { reason: payload.reason } },
          payload.eventId,
        );
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
          return;
        }
        publishNotification(record);
        if (payload.email) {
          await dispatchMail(record.userId, payload.email, payload.input.eventId ?? record.id);
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
      mailDispatchRef = c.has(MAIL_DISPATCH) ? c.get(MAIL_DISPATCH) : null;
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

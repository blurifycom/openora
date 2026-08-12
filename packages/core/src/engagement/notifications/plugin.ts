import * as z from 'zod';
import {
  ADMIN_USER_DIRECTORY,
  JOB_QUEUE,
  NOTIFICATION_DELIVERY_ADAPTER,
  UuidSchema,
  domainEventSchemas,
  queue,
  type AdminUserDirectory,
  type JobQueueAdapter,
  type NotificationDeliveryAdapter,
} from '@openora/core/contracts';
import { createLogger, EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { MockNotificationDeliveryAdapter } from './adapters/mock/mock-notification-adapter.js';
import { createNotificationsRouter } from './router/index.js';
import { NotificationsService } from './service/notifications.service.js';

const KYC_RESUBMISSION_NOTIFY_QUEUE = queue('kyc-resubmission-notify');

const KycResubmissionNotifyJobSchema = z.object({
  userId: UuidSchema,
  reason: z.string().nullable(),
});

export default {
  id: 'notifications',
  // ADMIN_USER_DIRECTORY (owned by identity) resolves the player's email for the
  // withdrawal delivery emails; pin load order so a split still finds the port. See ADR-0017.
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => new MockNotificationDeliveryAdapter());

    const logger = createLogger('notifications');

    // Subscriptions are wired before router factories run (boot order), so these refs are
    // null at registration but set from the router factory before any real event arrives.
    let svcRef: NotificationsService | null = null;
    let deliveryRef: NotificationDeliveryAdapter | null = null;
    let directoryRef: AdminUserDirectory | null = null;
    let jobQueueRef: JobQueueAdapter | null = null;

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

    ctx.events.on('wallet.withdrawal.approved', (payload) => {
      const parsed = domainEventSchemas['wallet.withdrawal.approved'].safeParse(payload);
      if (!parsed.success || !svcRef) {
        return;
      }
      const p = parsed.data;
      const title = 'Withdrawal approved';
      const body = `Your withdrawal of ${p.amount} ${p.currency} has been approved and is being processed.`;
      svcRef
        .create({ userId: p.userId, type: 'withdrawal.approved', title, body })
        .catch((err) => logger.error({ err }, 'withdrawal.approved notification failed'));
      sendEmail(p.userId, title, body);
    });

    ctx.events.on('wallet.withdrawal.rejected', (payload) => {
      const parsed = domainEventSchemas['wallet.withdrawal.rejected'].safeParse(payload);
      if (!parsed.success || !svcRef) {
        return;
      }
      const p = parsed.data;
      const reason = p.reason ? ` Reason: ${p.reason}.` : '';
      const title = 'Withdrawal rejected';
      const body = `Your withdrawal of ${p.amount} ${p.currency} was rejected and the funds were returned to your balance.${reason}`;
      svcRef
        .create({ userId: p.userId, type: 'withdrawal.rejected', title, body })
        .catch((err) => logger.error({ err }, 'withdrawal.rejected notification failed'));
      sendEmail(p.userId, title, body);
    });

    ctx.events.on('social.friend_request.sent', (payload) => {
      const parsed = domainEventSchemas['social.friend_request.sent'].safeParse(payload);
      if (!parsed.success || !svcRef) {
        return;
      }
      const p = parsed.data;
      const title = 'New friend request';
      const body = `${p.requesterDisplayName} sent you a friend request.`;
      svcRef
        .create({ userId: p.addresseeId, type: 'social.friend_request.received', title, body })
        .catch((err) => logger.error({ err }, 'social.friend_request.sent notification failed'));
    });

    ctx.events.on('social.friend_request.accepted', (payload) => {
      const parsed = domainEventSchemas['social.friend_request.accepted'].safeParse(payload);
      if (!parsed.success || !svcRef) {
        return;
      }
      const p = parsed.data;
      const title = 'Friend request accepted';
      const body = `${p.accepterDisplayName} accepted your friend request.`;
      svcRef
        .create({ userId: p.requesterId, type: 'social.friend_request.accepted', title, body })
        .catch((err) =>
          logger.error({ err }, 'social.friend_request.accepted notification failed'),
        );
    });

    ctx.events.on('compliance.kyc.updated', (payload, envelope) => {
      const parsed = domainEventSchemas['compliance.kyc.updated'].safeParse(payload);
      if (!parsed.success || !jobQueueRef) {
        return;
      }
      const p = parsed.data;
      if (p.status !== 'resubmission_requested' || p.source !== 'manual') {
        return;
      }
      jobQueueRef
        .enqueue(
          KYC_RESUBMISSION_NOTIFY_QUEUE,
          { userId: p.userId, reason: p.reason },
          { idempotencyKey: `kyc-resubmission-notify:${envelope?.eventId ?? p.userId}` },
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
        const reasonText = payload.reason ? ` Reason: ${payload.reason}.` : '';
        const title = 'Document resubmission required';
        const body = `An admin has requested you resubmit your verification documents.${reasonText}`;
        await svcRef.create({
          userId: payload.userId,
          type: 'kyc.resubmission_requested',
          title,
          body,
        });
        sendEmail(payload.userId, title, body);
      },
    });

    ctx.routers.add('notifications', (c) => {
      const svc = new NotificationsService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      deliveryRef = c.get(NOTIFICATION_DELIVERY_ADAPTER);
      directoryRef = c.get(ADMIN_USER_DIRECTORY);
      jobQueueRef = c.get(JOB_QUEUE);
      return createNotificationsRouter(svc);
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

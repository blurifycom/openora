import {
  ADMIN_USER_DIRECTORY,
  NOTIFICATION_DELIVERY_ADAPTER,
  domainEventSchemas,
  type AdminUserDirectory,
  type NotificationDeliveryAdapter,
} from '@blurifycom/core/contracts';
import { createLogger, definePlugin, EVENT_BUS, DRIZZLE } from '@blurifycom/core/server';
import { MockNotificationDeliveryAdapter } from './adapters/mock/mock-notification-adapter.js';
import { createNotificationsRouter } from './router/index.js';
import { NotificationsService } from './service/notifications.service.js';

export default definePlugin({
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

    // Best-effort email alongside the in-app notification; a missing user or delivery
    // failure is logged, never thrown - the in-app notification already landed.
    const sendEmail = (userId: string, title: string, body: string) => {
      if (!deliveryRef || !directoryRef) return;
      const delivery = deliveryRef;
      directoryRef
        .get(userId)
        .then((user) => {
          if (!user?.email) {
            logger.warn({ userId }, 'withdrawal email skipped: no email for user');
            return;
          }
          return delivery.sendEmail(user.email, title, body);
        })
        .catch((err) => logger.error({ err }, 'withdrawal email delivery failed'));
    };

    ctx.events.on('wallet.withdrawal.approved', (payload) => {
      const parsed = domainEventSchemas['wallet.withdrawal.approved'].safeParse(payload);
      if (!parsed.success || !svcRef) return;
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
      if (!parsed.success || !svcRef) return;
      const p = parsed.data;
      const reason = p.reason ? ` Reason: ${p.reason}.` : '';
      const title = 'Withdrawal rejected';
      const body = `Your withdrawal of ${p.amount} ${p.currency} was rejected and the funds were returned to your balance.${reason}`;
      svcRef
        .create({ userId: p.userId, type: 'withdrawal.rejected', title, body })
        .catch((err) => logger.error({ err }, 'withdrawal.rejected notification failed'));
      sendEmail(p.userId, title, body);
    });

    ctx.routers.add('notifications', (c) => {
      const svc = new NotificationsService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      deliveryRef = c.get(NOTIFICATION_DELIVERY_ADAPTER);
      directoryRef = c.get(ADMIN_USER_DIRECTORY);
      return createNotificationsRouter(svc);
    });
  },
});

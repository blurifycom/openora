import { NOTIFICATION_DELIVERY_ADAPTER, domainEventSchemas } from '@blurifycom/core/contracts';
import { createLogger, definePlugin, EVENT_BUS, DRIZZLE } from '@blurifycom/core/server';
import { MockNotificationDeliveryAdapter } from './adapters/mock/mock-notification-adapter.js';
import { createNotificationsRouter } from './router/index.js';
import { NotificationsService } from './service/notifications.service.js';

export default definePlugin({
  id: 'notifications',
  register(ctx) {
    ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => new MockNotificationDeliveryAdapter());

    const logger = createLogger('notifications');

    // Subscriptions are wired before router factories run (boot order), so svcRef is
    // null at registration but set before any real event arrives.
    let svcRef: NotificationsService | null = null;

    ctx.events.on('wallet.withdrawal.approved', (payload) => {
      const parsed = domainEventSchemas['wallet.withdrawal.approved'].safeParse(payload);
      if (!parsed.success || !svcRef) return;
      const p = parsed.data;
      svcRef
        .create({
          userId: p.userId,
          type: 'withdrawal.approved',
          title: 'Withdrawal approved',
          body: `Your withdrawal of ${p.amount} ${p.currency} has been approved and is being processed.`,
        })
        .catch((err) => logger.error({ err }, 'withdrawal.approved notification failed'));
    });

    ctx.events.on('wallet.withdrawal.rejected', (payload) => {
      const parsed = domainEventSchemas['wallet.withdrawal.rejected'].safeParse(payload);
      if (!parsed.success || !svcRef) return;
      const p = parsed.data;
      const reason = p.reason ? ` Reason: ${p.reason}.` : '';
      svcRef
        .create({
          userId: p.userId,
          type: 'withdrawal.rejected',
          title: 'Withdrawal rejected',
          body: `Your withdrawal of ${p.amount} ${p.currency} was rejected and the funds were returned to your balance.${reason}`,
        })
        .catch((err) => logger.error({ err }, 'withdrawal.rejected notification failed'));
    });

    ctx.routers.add('notifications', (c) => {
      const svc = new NotificationsService(c.get(DRIZZLE), c.get(EVENT_BUS));
      svcRef = svc;
      return createNotificationsRouter(svc);
    });
  },
});

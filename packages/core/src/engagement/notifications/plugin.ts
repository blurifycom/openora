import { NOTIFICATION_DELIVERY_ADAPTER } from '@blurifycom/core/contracts';
import { definePlugin } from '@blurifycom/core/server';
import { EVENT_BUS } from '@blurifycom/core/server';
import { DRIZZLE } from '@blurifycom/core/server';
import { MockNotificationDeliveryAdapter } from './adapters/mock/mock-notification-adapter.js';
import { createNotificationsRouter } from './router/index.js';
import { NotificationsService } from './service/notifications.service.js';

export default definePlugin({
  id: 'notifications',
  register(ctx) {
    ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => new MockNotificationDeliveryAdapter());
    ctx.routers.add('notifications', (c) =>
      createNotificationsRouter(new NotificationsService(c.get(DRIZZLE), c.get(EVENT_BUS))),
    );
  },
});

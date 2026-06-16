import { NOTIFICATION_DELIVERY_ADAPTER } from '@oss/core/contracts';
import { definePlugin } from '@oss/core/server';
import { EVENT_BUS } from '@oss/core/server';
import { DRIZZLE } from '@oss/core/server';
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

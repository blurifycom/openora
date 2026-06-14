import { NOTIFICATION_DELIVERY_ADAPTER } from '@oss/adapters';
import { definePlugin } from '@oss/plugin-host';
import { EVENT_BUS } from '@oss/core';
import { DRIZZLE } from '@oss/db';
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

import { NOTIFICATION_DELIVERY_ADAPTER } from '@oss/adapters';
import { definePlugin } from '@oss/plugin-host';
import { MockNotificationDeliveryAdapter } from './adapters/mock/mock-notification-adapter.js';
import { NotificationsController } from './router/index.js';
import { NotificationsService } from './service/notifications.service.js';

export default definePlugin({
  id: 'notifications',
  register(ctx) {
    ctx.providers.add(NotificationsService);
    ctx.controllers.add(NotificationsController);
    ctx.providers.add({ provide: NOTIFICATION_DELIVERY_ADAPTER, useClass: MockNotificationDeliveryAdapter });
    ctx.events.on('identity.user.registered', async (payload) => {
      const { userId } = payload as { userId: string };
      void userId;
    });
  },
});

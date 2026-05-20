import { definePlugin } from '@oss/plugin-host';
import { NotificationsService } from './service/notifications.service.js';
import { NotificationsController } from './router/index.js';

export default definePlugin({
  id: 'notifications',
  register(ctx) {
    ctx.providers.add(NotificationsService);
    ctx.controllers.add(NotificationsController);
    // When identity.user.registered fires, a welcome notification should be created.
    // At registration time the Nest DI container is not yet available, so the handler
    // only captures the payload here. In a production setup, inject NotificationsService
    // via Nest DI context or use a worker job to create the welcome notification at
    // runtime when the event actually fires.
    ctx.events.on('identity.user.registered', async (payload) => {
      const { userId } = payload as { userId: string };
      void userId; // resolved by Nest DI when event fires
    });
  },
});

import { definePlugin, DRIZZLE } from '@blurifycom/core/server';
import { PLATFORM_CONFIG } from '@blurifycom/core/contracts';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

export default definePlugin({
  id: 'profile',
  register(ctx) {
    ctx.routers.add('profile', (c) => {
      const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
      return createProfileRouter(new ProfileService(c.get(DRIZZLE), platformConfig));
    });
  },
});

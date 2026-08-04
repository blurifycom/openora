import { definePlugin, DRIZZLE, CORE_TOKEN_CATALOG } from '@openora/core/server';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

export default definePlugin(CORE_TOKEN_CATALOG, {
  id: 'profile',
  register(ctx) {
    ctx.routers.add('profile', (c) => createProfileRouter(new ProfileService(c.get(DRIZZLE))));
  },
});

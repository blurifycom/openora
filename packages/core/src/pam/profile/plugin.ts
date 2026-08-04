import { definePluginWithCatalog, DRIZZLE, type CoreTokenCatalog } from '@openora/core/server';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

export default definePluginWithCatalog<CoreTokenCatalog>()({
  id: 'profile',
  register(ctx) {
    ctx.routers.add('profile', (c) => createProfileRouter(new ProfileService(c.get(DRIZZLE))));
  },
});

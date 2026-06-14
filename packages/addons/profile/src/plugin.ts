import { definePlugin } from '@oss/plugin-host';
import { DRIZZLE } from '@oss/db';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

export default definePlugin({
  id: 'profile',
  register(ctx) {
    // Player-facing self-profile surface (verified session, not admin-guarded).
    ctx.routers.add('profile', (c) => createProfileRouter(new ProfileService(c.get(DRIZZLE))));
  },
});

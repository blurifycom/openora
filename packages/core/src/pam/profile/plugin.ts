import { DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLAYER_PROVISIONING } from '@openora/core/contracts';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

export default {
  id: 'profile',
  register(ctx) {
    ctx.provide(PLAYER_PROVISIONING, (c) => new ProfileService(c.get(DRIZZLE)));
    ctx.routers.add('profile', (c) => createProfileRouter(new ProfileService(c.get(DRIZZLE))));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

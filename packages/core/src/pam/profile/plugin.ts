import { DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import { PLAYER_PROVISIONING } from '@openora/core/contracts';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

const makeProfileService = (c: TypedContainer<CoreTokenCatalog>) =>
  new ProfileService(c.get(DRIZZLE));

export default {
  id: 'profile',
  register(ctx) {
    ctx.provide(PLAYER_PROVISIONING, makeProfileService);
    ctx.routers.add('profile', (c) => createProfileRouter(makeProfileService(c)));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

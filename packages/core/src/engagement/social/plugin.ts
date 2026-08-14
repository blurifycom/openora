import { EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SocialService } from './service/social.service.js';
import { createSocialRouter } from './router/index.js';

// DI wiring only - no business logic here. sendFriendRequest/getRelationships read
// the `player` table via the read-only @openora/core/pam/schema/profile subpath
// (ADR-0020), not a DI token/command port, so no dependsOn is needed to pin load
// order - the imported pgTable is a plain object available regardless of plugin
// registration order.
export default {
  id: 'social',
  dependsOn: ['chat'],
  register(ctx) {
    ctx.routers.add('social', (c) =>
      createSocialRouter(new SocialService(c.get(DRIZZLE), c.get(EVENT_BUS))),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

import { domainEventSchemas } from '@openora/core/contracts';
import { EVENT_BUS, DRIZZLE, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SocialService } from './service/social.service.js';
import { createSocialRouter } from './router/index.js';

const logger = createLogger('social');

// DI wiring only - no business logic here. sendFriendRequest/getRelationships read
// the `player` table via the read-only @openora/core/pam/schema/profile subpath
// (ADR-0020), not a DI token/command port, so no dependsOn is needed to pin load
// order - the imported pgTable is a plain object available regardless of plugin
// registration order.
export default {
  id: 'social',
  dependsOn: ['chat'],
  register(ctx) {
    // Subscriptions are wired before router factories run (create-app.ts boot order),
    // so svcRef is null at registration but set before any real event arrives - see
    // notifications/plugin.ts and tag/plugin.ts for the same pattern.
    let socialRef: SocialService | null = null;

    // Blocking a player must also dissolve any active friendship with them (BF-427) -
    // reuses the chat module's existing block infra rather than duplicating it. Never
    // throws into the event bus dispatch: a failure here is logged, not propagated.
    ctx.events.on('chat.user.blocked', (payload) => {
      const parsed = domainEventSchemas['chat.user.blocked'].safeParse(payload);
      if (!parsed.success || !socialRef) {
        return;
      }
      const p = parsed.data;
      socialRef
        .dissolveFriendshipOnBlock(p.blockerId, p.blockedId)
        .catch((err: unknown) => logger.error({ err }, 'dissolveFriendshipOnBlock failed'));
    });

    ctx.routers.add('social', (c) => {
      socialRef = new SocialService(c.get(DRIZZLE), c.get(EVENT_BUS));
      return createSocialRouter(socialRef);
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

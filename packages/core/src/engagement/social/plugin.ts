import { domainEventSchemas, IDENTITY_READER } from '@openora/core/contracts';
import { EVENT_BUS, DRIZZLE, createLogger } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { SocialService } from './service/social.service.js';
import { createSocialRouter } from './router/index.js';

const logger = createLogger('social');

export default {
  id: 'social',
  dependsOn: ['chat', 'identity'],
  register(ctx) {
    let socialRef: SocialService | null = null;

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
      socialRef = new SocialService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(IDENTITY_READER));
      return createSocialRouter(socialRef);
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;

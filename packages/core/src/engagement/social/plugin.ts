import { IDENTITY_READER, SOCIAL_COMMANDS } from '@openora/core/contracts';
import { EVENT_BUS, DRIZZLE } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import { SocialService } from './service/social.service.js';
import { createSocialRouter } from './router/index.js';

export default {
  id: 'social',
  dependsOn: ['chat', 'identity'],
  register(ctx) {
    let svc: SocialService | null = null;
    const socialService = (c: TypedContainer<CoreTokenCatalog>) =>
      (svc ??= new SocialService(c.get(DRIZZLE), c.get(EVENT_BUS), c.get(IDENTITY_READER)));

    ctx.provide(SOCIAL_COMMANDS, (c) => ({
      dissolveFriendshipOnBlock: (tx, blockerId, blockedId) =>
        socialService(c).dissolveFriendshipOnBlock(tx, blockerId, blockedId),
    }));

    ctx.routers.add('social', (c) => createSocialRouter(socialService(c)));
  },
} as const satisfies Plugin<CoreTokenCatalog>;

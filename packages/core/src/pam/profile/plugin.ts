import { definePlugin, DRIZZLE } from '@blurifycom/core/server';
import { PLATFORM_CONFIG, type PlatformConfig, type Token } from '@blurifycom/core/contracts';
import { ProfileService } from './service/profile.service.js';
import { createProfileRouter } from './router/index.js';

// PLATFORM_CONFIG is a plain symbol; cast to Token<PlatformConfig> for the typed Container.
const PLATFORM_CONFIG_TOKEN = PLATFORM_CONFIG as unknown as Token<PlatformConfig>;

export default definePlugin({
  id: 'profile',
  register(ctx) {
    ctx.routers.add('profile', (c) => {
      const platformConfig = c.has(PLATFORM_CONFIG_TOKEN)
        ? c.get(PLATFORM_CONFIG_TOKEN)
        : undefined;
      return createProfileRouter(new ProfileService(c.get(DRIZZLE), platformConfig));
    });
  },
});

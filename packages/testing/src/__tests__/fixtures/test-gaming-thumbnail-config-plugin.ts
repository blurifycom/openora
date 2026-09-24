import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-gaming-thumbnail-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        gaming: { allowedThumbnailHosts: ['cdn.example'] },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

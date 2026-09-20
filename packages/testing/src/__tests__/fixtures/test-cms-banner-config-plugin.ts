import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-cms-banner-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        cms: { allowedBannerImageHosts: ['img.example.test'] },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

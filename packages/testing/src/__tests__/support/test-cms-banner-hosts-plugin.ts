import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export const BANNER_IMAGE_HOST = 'cdn.banners.e2e.test';

export default {
  id: 'testing-cms-banner-hosts',
  dependsOn: ['cms', 'identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        cms: { allowedBannerImageHosts: [BANNER_IMAGE_HOST] },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

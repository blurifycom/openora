import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'test-bonus-single-slot-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        promo: { bonus: { grantConcurrency: 'single' } },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

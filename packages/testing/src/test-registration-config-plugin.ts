import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

/** Enables the explicit operator registration configuration for test apps only. */
export default {
  id: 'testing-registration-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: {
          termsVersion: 'test-v1',
          webUrl: 'http://localhost:3000',
        },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

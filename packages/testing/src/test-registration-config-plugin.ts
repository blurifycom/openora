import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-registration-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: {
          termsVersion: 'test-v1',
          webUrl: 'http://localhost:3000',
          requireEmailVerification: true,
        },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-strict-session',
  dependsOn: ['identity', 'testing-registration-config'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        adminSecurity: { bindSessionToDevice: true, ipChangePolicy: 'any' },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

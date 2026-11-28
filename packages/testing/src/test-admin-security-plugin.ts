import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-admin-security',
  dependsOn: ['identity', 'testing-registration-config'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        adminSecurity: { requireTwoFactor: true, bindSessionToDevice: true, ipChangePolicy: 'off' },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

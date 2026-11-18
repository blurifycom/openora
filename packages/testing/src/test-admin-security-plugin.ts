import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

/**
 * The Backoffice policy a consumer runs: a second factor is mandatory and a session is bound to
 * the device it was issued to. Boot only the service that owns identity with this, so an e2e can
 * tell a service that enforces it from one that merely repeats what identity decides.
 */
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

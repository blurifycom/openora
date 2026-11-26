import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';
import { TEST_TURNOVER_NEVER } from './turnover-gate-config.js';

export default {
  id: 'testing-wallet-turnover-deposits-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        wallet: {
          reconciliation: { cron: TEST_TURNOVER_NEVER },
          turnover: {
            multiplier: '1',
            creditTypes: ['deposit', 'donation'],
            pricingCron: TEST_TURNOVER_NEVER,
          },
        },
      }),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

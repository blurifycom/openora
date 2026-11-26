import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';
import { TEST_TURNOVER_NEVER } from './turnover-gate-config.js';

export default {
  id: 'testing-wallet-turnover-credits-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        wallet: {
          transferCredits: 'cash',
          turnover: {
            multiplier: '1',
            creditTypes: ['deposit', 'swap_in', 'gift', 'rain', 'donation'],
            pricingCron: TEST_TURNOVER_NEVER,
          },
        },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

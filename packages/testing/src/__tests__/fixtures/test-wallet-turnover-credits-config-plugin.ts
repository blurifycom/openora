import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

const NEVER_DURING_A_TEST_RUN = '0 0 29 2 *';

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
            pricingCron: NEVER_DURING_A_TEST_RUN,
          },
        },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

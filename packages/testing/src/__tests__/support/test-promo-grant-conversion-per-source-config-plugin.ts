import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';
import { TEST_TURNOVER_LOCKED_MESSAGE, TEST_TURNOVER_NEVER } from './turnover-gate-config.js';
import { TEST_LOCKED_FUNDS_MESSAGE } from './test-bonus-withdrawal-block-config-plugin.js';

export default {
  id: 'testing-promo-grant-conversion-per-source-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        promo: {
          bonus: {
            grantConcurrency: 'per_source',
            withdrawalWhileActive: 'block',
            lockedFundsMessage: TEST_LOCKED_FUNDS_MESSAGE,
          },
        },
        wallet: {
          turnover: {
            multiplier: '1',
            creditTypes: ['swap_in'],
            pricingCron: TEST_TURNOVER_NEVER,
            lockedMessage: TEST_TURNOVER_LOCKED_MESSAGE,
          },
        },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

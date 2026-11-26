import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-wallet-turnover-off-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        wallet: {
          transferCredits: 'cash',
          turnover: {
            multiplier: '0',
            creditTypes: ['deposit', 'swap_in', 'gift', 'rain', 'donation'],
          },
        },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-rakeback-claim-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        wallet: { defaultReferenceCurrency: 'USDT' },
        promo: { rakeback: { basis: 'margin', payout: 'claim', claimMinimum: '0.10' } },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-rakeback-stake-claim-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        wallet: { defaultReferenceCurrency: 'USDT' },
        promo: { rakeback: { basis: 'stake', payout: 'claim', claimMinimum: '0.01' } },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export default {
  id: 'testing-rakeback-claim',
  dependsOn: ['wallet', 'identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        promo: { rakeback: { payout: 'claim' } },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

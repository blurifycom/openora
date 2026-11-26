import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

export const TEST_LOCKED_FUNDS_MESSAGE = 'Finish your active bonus before moving this money';

export default {
  id: 'testing-bonus-withdrawal-block-config',
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        promo: {
          bonus: { withdrawalWhileActive: 'block', lockedFundsMessage: TEST_LOCKED_FUNDS_MESSAGE },
        },
      }),
    );
  },
} satisfies Plugin<CoreTokenCatalog>;

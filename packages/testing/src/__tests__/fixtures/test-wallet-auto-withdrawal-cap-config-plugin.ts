import { definePlugin, CORE_TOKEN_CATALOG } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

// PLATFORM_CONFIG overlay for the daily-cap scenario: dailyCapCount 1 trips on the 2nd withdrawal, still below
// the high_frequency heuristic (>= 3) so the cap gate is tested in isolation. Separate app since config is boot-once.
export default definePlugin(CORE_TOKEN_CATALOG, {
  id: 'test-wallet-auto-withdrawal-cap-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        autoWithdrawal: { enabled: true, fiatThreshold: '2', dailyCapCount: 1 },
      }),
    );
  },
});

import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

// PLATFORM_CONFIG overlay for the daily-cap scenario: dailyCapCount 1 trips on the 2nd withdrawal, still below
// the high_frequency heuristic (>= 3) so the cap gate is tested in isolation. Separate app since config is boot-once.
// The fiat threshold ('2') is the DB-backed wallet_auto_withdrawal_config singleton, seeded by the
// test file's own beforeAll - this static config no longer carries it.
export default {
  id: 'test-wallet-auto-withdrawal-cap-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        autoWithdrawal: { enabled: true, dailyCapCount: 1 },
      }),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

// PLATFORM_CONFIG overlay for the auto-withdrawal e2e suite: autoWithdrawal enabled (the fiat
// threshold - '2' - is the DB-backed wallet_auto_withdrawal_config singleton, seeded by the
// test file's own beforeAll, not this static config), caps set high. high_risk/bonus_abuser
// exclusion comes from that same DB row's excludeRiskFlags column (the migration
// DEFAULT, left untouched by this suite) - no excludeRiskFlags field here any more.
// kyc.gateWithdrawals stays false so the KYC-not-passing scenario hits the auto-approval KYC
// gate, not the withdraw-time one. Append last so this binding wins.
export default {
  id: 'test-wallet-auto-withdrawal-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1', webUrl: 'http://localhost:3000' },
        kyc: { gateWithdrawals: false },
        autoWithdrawal: {
          enabled: true,
          dailyCapAmount: '1000',
          dailyCapCount: 100,
        },
      }),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

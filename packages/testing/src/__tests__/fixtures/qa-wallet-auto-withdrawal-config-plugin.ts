import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

// PLATFORM_CONFIG overlay for the QA suite: autoWithdrawal enabled with NO
// fiatThreshold/cryptoThreshold here (those moved to the DB-backed
// wallet_auto_withdrawal_config singleton row - AutoWithdrawalConfigSchema no longer
// has these fields at all). excludeRiskFlags also moved off this static schema -
// the DB row's excludeRiskFlags column, seeded via seedAutoWithdrawalConfig's migration
// default, drives exclusion now. kyc.gateWithdrawals stays false so KYC-not-passing
// scenarios exercise the auto-approval KYC gate, not the withdraw-time one.
export default {
  id: 'qa-wallet-auto-withdrawal-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1', webUrl: 'http://localhost:3000' },
        kyc: { gateWithdrawals: false },
        autoWithdrawal: {
          enabled: true,
          dailyCapAmount: '1000000',
          dailyCapCount: 1000,
        },
      }),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;

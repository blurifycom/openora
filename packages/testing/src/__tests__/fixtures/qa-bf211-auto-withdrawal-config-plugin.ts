import { definePlugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

// PLATFORM_CONFIG overlay for the BF-211 QA suite: autoWithdrawal enabled with NO
// fiatThreshold/cryptoThreshold here (BF-211 moved those to the DB-backed
// wallet_auto_withdrawal_config singleton row - AutoWithdrawalConfigSchema no longer
// has these fields at all). excludeRiskFlags also moved off this static schema (BF-319) -
// the DB row's excludeRiskFlags column, seeded via seedAutoWithdrawalConfig's migration
// default, drives exclusion now. kyc.gateWithdrawals stays false so KYC-not-passing
// scenarios exercise the auto-approval KYC gate, not the withdraw-time one.
export default definePlugin({
  id: 'qa-bf211-auto-withdrawal-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        kyc: { gateWithdrawals: false },
        autoWithdrawal: {
          enabled: true,
          dailyCapAmount: '1000000',
          dailyCapCount: 1000,
        },
      }),
    );
  },
});

import { definePlugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

// PLATFORM_CONFIG overlay for the auto-withdrawal e2e suite: autoWithdrawal enabled (threshold 200,
// high_risk/bonus_abuser excluded, caps set high). kyc.gateWithdrawals stays false so the KYC-not-passing
// scenario hits the auto-approval KYC gate, not the withdraw-time one. Append last so this binding wins.
export default definePlugin({
  id: 'test-wallet-auto-withdrawal-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        kyc: { gateWithdrawals: false },
        autoWithdrawal: {
          enabled: true,
          fiatThreshold: 200,
          excludeRiskFlags: ['high_risk', 'bonus_abuser'],
          dailyCapAmount: 100_000,
          dailyCapCount: 100,
        },
      }),
    );
  },
});

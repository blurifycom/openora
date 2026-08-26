import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { PLATFORM_CONFIG, definePlatformConfig } from '@openora/core/contracts';

// PLATFORM_CONFIG overlay for the QA suite (excludeRiskFlags moved off static
// config onto the DB-backed wallet_auto_withdrawal_config singleton's excludeRiskFlags
// column). autoWithdrawal.enabled with no fiatThreshold/cryptoThreshold/excludeRiskFlags
// here - all three now live exclusively on the DB row (thresholds and the exclusion
// list both moved off the static schema). Caps set high so they never interfere with
// the tag-exclusion gate under test. kyc.gateWithdrawals stays false so a not-yet-verified
// player hits the auto-approval KYC gate, not the withdraw-time one.
export default {
  id: 'qa-wallet-auto-withdrawal-exclude-risk-flags',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
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

import { definePlugin } from '@openora/core/server';
import {
  PLATFORM_CONFIG,
  KYC_ADAPTER,
  definePlatformConfig,
  type KycAdapter,
  type KycDocument,
  type KycResult,
} from '@openora/core/contracts';

/**
 * Test-only KYC adapter: never auto-approves (so the withdrawal-gate boot guard stays
 * quiet) and implements `parseWebhook` so an e2e test can drive a real vendor-style
 * webhook reconcile, mirroring how a real provider overlay (Didit/SumSub) would bind.
 * Every `submit` starts a player at vendor `pending`; tests flip it via the webhook route.
 */
class ControllablePendingKycAdapter implements KycAdapter {
  readonly autoApproves = false;

  async submit(userId: string, _docs: KycDocument[]): Promise<KycResult> {
    return { referenceId: `test-${userId}`, status: 'pending' };
  }

  async getStatus(_userId: string): Promise<KycResult['status']> {
    return 'pending';
  }

  parseWebhook(rawBody: string): KycResult | null {
    try {
      const parsed = JSON.parse(rawBody) as Partial<KycResult>;
      if (typeof parsed.referenceId !== 'string' || typeof parsed.status !== 'string') return null;
      return { referenceId: parsed.referenceId, status: parsed.status as KycResult['status'] };
    } catch {
      return null;
    }
  }
}

/**
 * Test-fixture overlay - binds `PLATFORM_CONFIG` (kyc gate + re-KYC thresholds) and swaps
 * `KYC_ADAPTER` for a controllable stub. Append last in a test's `plugins` array so both
 * bindings win over the defaults (last-registration-wins; see clean-architecture > ports).
 */
export default definePlugin({
  id: 'test-kyc-config',
  dependsOn: ['identity'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        kyc: {
          gateWithdrawals: true,
          reverifyThresholds: { USD: 1000, EUR: 1000 },
        },
      }),
    );
    ctx.provide(KYC_ADAPTER, () => new ControllablePendingKycAdapter());
  },
});

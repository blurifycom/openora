// MockKycAdapter - auto-approves all submissions in dev/test.
// Replace via overlay: ctx.provide(KYC_ADAPTER, () => new SumsubKycAdapter())
// Intended real provider: SumSub (https://sumsub.com). See docs/adapters/kyc.md.
import type { KycAdapter, KycDocument, KycResult, KycVendorStatus } from '@oss/core/contracts';

export class MockKycAdapter implements KycAdapter {
  async submit(userId: string, _docs: KycDocument[]): Promise<KycResult> {
    return { referenceId: `mock-${userId}`, status: 'approved' };
  }

  async getStatus(_userId: string): Promise<KycVendorStatus> {
    return 'approved';
  }
}

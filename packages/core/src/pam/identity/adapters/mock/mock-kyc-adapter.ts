// Replace via overlay: ctx.provide(KYC_ADAPTER, () => new SumsubKycAdapter()) - see docs/adapters/kyc.md.
import type { KycAdapter, KycDocument, KycResult, KycVendorStatus } from '@openora/core/contracts';

export class MockKycAdapter implements KycAdapter {
  readonly autoApproves = true;

  async submit(userId: string, _docs: KycDocument[]): Promise<KycResult> {
    return { referenceId: `mock-${userId}`, status: 'approved' };
  }

  async getStatus(_userId: string): Promise<KycVendorStatus> {
    return 'approved';
  }
}

// Replace via overlay: ctx.provide(KYC_ADAPTER, () => new SumsubKycAdapter()) - see docs/adapters/kyc.md.
import type {
  KycAdapter,
  KycDocument,
  KycResult,
  KycTier,
  KycVendorStatus,
} from '@openora/core/contracts';

export class MockKycAdapter implements KycAdapter {
  readonly autoApproves = true;

  async submit(userId: string, _docs: KycDocument[], tier: KycTier): Promise<KycResult> {
    return { referenceId: `mock-${userId}-${tier}`, status: 'approved' };
  }

  async getStatus(_userId: string, _tier: KycTier): Promise<KycVendorStatus> {
    return 'approved';
  }
}

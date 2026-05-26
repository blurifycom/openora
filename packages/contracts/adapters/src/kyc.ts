// KYC/identity-verification seam. Intended real provider: SumSub (https://sumsub.com).
// The identity module ships MockKycAdapter (auto-approves) as the default binding.
// Override via overlay: ctx.providers.add({ provide: KYC_ADAPTER, useClass: SumsubKycAdapter })
// Load your overlay AFTER the identity plugin in extensions.config.ts (last registration wins).
// See docs/adapters/kyc.md for the full binding guide.

export interface KycDocument {
  type: 'passport' | 'drivers_license' | 'national_id';
  frontUrl: string;
  backUrl?: string;
}

export type KycStatus = 'pending' | 'approved' | 'rejected' | 'not_started';

export interface KycResult {
  referenceId: string;
  status: KycStatus;
}

export interface KycAdapter {
  submit(userId: string, documents: KycDocument[]): Promise<KycResult>;
  getStatus(userId: string): Promise<KycStatus>;
}

export const KYC_ADAPTER = Symbol('KYC_ADAPTER');

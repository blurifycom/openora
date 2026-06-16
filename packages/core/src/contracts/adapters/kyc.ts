// KYC/identity-verification seam. Intended real provider: SumSub (https://sumsub.com).
// The identity module ships MockKycAdapter (auto-approves) as the default binding.
// Override via overlay: ctx.provide(KYC_ADAPTER, () => new SumsubKycAdapter())
// Load your overlay AFTER the identity plugin in extensions.config.ts (last registration wins).
// See docs/adapters/kyc.md for the full binding guide.
import { createToken, type Token } from './token.js';

export type KycDocument = {
  type: 'passport' | 'drivers_license' | 'national_id';
  frontUrl: string;
  backUrl?: string;
};

export type KycVendorStatus = 'pending' | 'approved' | 'rejected' | 'not_started';

export type KycResult = {
  referenceId: string;
  status: KycVendorStatus;
};

export type KycAdapter = {
  submit(userId: string, documents: KycDocument[]): Promise<KycResult>;
  getStatus(userId: string): Promise<KycVendorStatus>;
};

export const KYC_ADAPTER: Token<KycAdapter> = createToken('KYC_ADAPTER');

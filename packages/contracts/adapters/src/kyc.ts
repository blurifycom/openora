// KYC/identity-verification seam. A vendor (eg Sumsub) implements KycAdapter; bind
// a concrete adapter to KYC_ADAPTER in the identity module's plugin.ts.

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

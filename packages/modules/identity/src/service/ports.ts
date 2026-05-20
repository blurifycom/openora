// Adapter interfaces (ports) for identity third-party integrations.
// Implement adapters in adapters/<vendor>/ and bind via Nest DI.

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

export interface KycPort {
  submit(userId: string, documents: KycDocument[]): Promise<KycResult>;
  getStatus(userId: string): Promise<KycStatus>;
}

export const KYC_PORT = Symbol('KYC_PORT');

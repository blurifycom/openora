import * as z from 'zod';
import { createToken, type Token } from './token.js';
import type { KycStatus, KycStatusSource, KycTier, Player } from '../schemas/player.js';

export type KycDocument = {
  type: 'passport' | 'drivers_license' | 'national_id';
  frontUrl: string;
  backUrl?: string;
};

export const KYC_VENDOR_STATUSES = ['pending', 'approved', 'rejected', 'not_started'] as const;
export type KycVendorStatus = (typeof KYC_VENDOR_STATUSES)[number];

export const KYC_CHECK_STATUSES = [
  'not_started',
  'in_progress',
  'in_review',
  'approved',
  'declined',
  'expired',
  'unknown',
] as const;
export const KycCheckStatusSchema = z.enum(KYC_CHECK_STATUSES);
export type KycCheckStatus = z.infer<typeof KycCheckStatusSchema>;

export const KycCheckResultSchema = z.object({
  step: z.string(),
  status: KycCheckStatusSchema,
});
export type KycCheckResult = z.infer<typeof KycCheckResultSchema>;

export type KycResult = {
  referenceId: string;
  status: KycVendorStatus;
  tier?: KycTier;
  verificationUrl?: string;
  documentTypes?: KycDocument['type'][];
  decisionReason?: string;
  checks?: KycCheckResult[];
  dateOfBirth?: string;
};

export type KycRiskSignals = {
  vpnOrTorDetected: boolean;
  dataCenterIpDetected: boolean;
  duplicateDeviceDetected: boolean;
  highRiskCountryDetected: boolean;
  deviceFingerprints: string[];
};

export type KycAdapter = {
  readonly autoApproves?: boolean;
  submit(userId: string, documents: KycDocument[], tier: KycTier): Promise<KycResult>;
  getStatus(userId: string, tier: KycTier): Promise<KycVendorStatus>;
  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): KycResult | null;
  resolveDecision?(referenceId: string): Promise<KycResult>;
  resolveRiskSignals?(referenceId: string): Promise<KycRiskSignals>;
};

export const KYC_ADAPTER: Token<KycAdapter> = createToken('KYC_ADAPTER');

export type KycStatusWriter = {
  setStatus(
    userId: Player['userId'],
    status: KycStatus,
    opts: { actorId: Player['userId'] | null; reason?: string; source: KycStatusSource },
    tx?: unknown,
  ): Promise<KycStatusTransition | null>;
};

export type KycStatusTransition = {
  playerId: Player['id'];
  previousStatus: KycStatus;
};

export const KYC_STATUS_WRITER: Token<KycStatusWriter> = createToken('KYC_STATUS_WRITER');

export type KycWithdrawalPolicy = {
  requiresKycForWithdrawal(input: {
    userId: Player['userId'];
    pivotAmount: string | null;
    pivotCurrency: string;
  }): Promise<boolean>;
};

export const KYC_WITHDRAWAL_POLICY: Token<KycWithdrawalPolicy> =
  createToken('KYC_WITHDRAWAL_POLICY');

export type KycWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const KYC_WEBHOOK_VERIFIER: Token<KycWebhookVerifier> = createToken('KYC_WEBHOOK_VERIFIER');

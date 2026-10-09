import * as z from 'zod';

export const KYC_DOCUMENT_TYPES = ['passport', 'drivers_license', 'national_id'] as const;
export const KYC_TRIGGERED_BY = [
  'submission',
  'reverify_threshold',
  'manual',
  'exemption',
] as const;

export const KycDocumentTypeSchema = z.enum(KYC_DOCUMENT_TYPES);

export const KycTriggeredBySchema = z.enum(KYC_TRIGGERED_BY);

import * as z from 'zod';
import { KycTierSchema, UuidSchema, type DomainEventPayload } from '@openora/core/contracts';

export const KycResubmissionNotifyJobSchema = z.object({
  userId: UuidSchema,
  reason: z.string().nullable(),
  tier: KycTierSchema.default('basic'),
  eventId: UuidSchema.optional(),
});

export function isStaffKycResubmissionRequest(
  payload: Pick<DomainEventPayload<'compliance.kyc.updated'>, 'status' | 'source'>,
): boolean {
  return payload.status === 'resubmission_requested' && payload.source === 'manual';
}
